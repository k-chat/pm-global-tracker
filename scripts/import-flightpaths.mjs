#!/usr/bin/env node
/**
 * Bind flightpaths.com commercial route stats onto the tracker’s airport pairs.
 *
 *   npm run import:flights
 *
 * Raw HTML is cached in ./fp_cache so reruns skip the network.
 * flightpaths.com records commercial passenger flights only. Air India One
 * and Indian Air Force flights are not on it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MI_TO_KM = 1.609344;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "The Prime Minister’s Global Tracker.html");
const CACHE = path.join(ROOT, "fp_cache");
const OUT = path.join(ROOT, "data", "air-india-routes.json");
const HEADERS = { "User-Agent": "Mozilla/5.0 (research script; contact: you@example.com)" };
const SPOT = ["DEL-JFK", "DEL-LHR", "DEL-SIN", "DEL-PBH"];

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split(/\s+/)
    .join(" ")
    .trim();
}

function loadTrips(html) {
  const marker = "const D=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("const D= not found in tracker HTML");
  let depth = 0;
  for (let j = start + marker.length; j < html.length; j++) {
    const c = html[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start + marker.length, j + 1));
    }
  }
  throw new Error("unterminated tour data");
}

function directedPairs(trips) {
  const pairs = [];
  const seen = new Set();
  for (const trip of trips) {
    for (const leg of trip.L) {
      const key = `${leg[8]}-${leg[9]}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push([leg[8], leg[9]]);
      }
    }
  }
  return pairs;
}

// Every tour ends at New Delhi, but commercial sites do not record those exact
// airport pairs. Add an explicit great-circle estimate for any closing leg
// that still has no record, so the itinerary is complete on the page.
function returnEstimates(trips) {
  const estimates = new Map();
  for (const trip of trips) {
    const leg = trip.L[trip.L.length - 1];
    if (!leg || leg[9] !== "DEL") continue;
    const key = `${leg[8]}-${leg[9]}`;
    const km = Math.round(leg[7]);
    if (!estimates.has(key)) {
      estimates.set(key, {
        url: null,
        estimated: true,
        recorded_flights: null,
        km_min: km,
        km_max: km,
        great_circle_km: km,
        air_india: [],
        airspace: [],
        matched_direction: "same",
      });
    }
  }
  return estimates;
}

function extractElementById(html, id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const open = html.lastIndexOf("<div", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html.startsWith("<div", i)) depth++;
    else if (html.startsWith("</div", i)) {
      depth--;
      if (depth === 0) return html.slice(open, html.indexOf(">", i) + 1);
    }
  }
  return "";
}

export function parse(html, code) {
  const text = visibleText(html);
  const recorded = text.match(
    /Based on (\d+) recorded flights?, the distance can vary between (\d+) and (\d+) miles/
  );
  if (!recorded) return null;

  const airlines = [];
  // The page puts buttons and map labels immediately before the airline name, so a
  // loose "Name Recorded …" match swallows that prefix. These two names are the filter.
  const airlineRe =
    /(Air India Express|Air India) Recorded (\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2}) ((?:[A-Z0-9]{2}\d+(?:, )?)+)/g;
  for (const match of text.matchAll(airlineRe)) {
    const name = match[1];
    const numbers = match[4].split(",").map((item) => item.trim()).filter(Boolean);
    const existing = airlines.find((item) => item.airline === name);
    if (existing) {
      for (const number of numbers) {
        if (!existing.flight_numbers.includes(number)) existing.flight_numbers.push(number);
      }
      if (match[2] < existing.recorded_from) existing.recorded_from = match[2];
      if (match[3] > existing.recorded_to) existing.recorded_to = match[3];
    } else {
      airlines.push({
        airline: name,
        recorded_from: match[2],
        recorded_to: match[3],
        flight_numbers: numbers,
      });
    }
  }

  const airspace = [];
  const seenCountries = new Set();
  const countries = visibleText(extractElementById(html, "countriesContainer"));
  const airspaceRe = /([A-Z][A-Za-z.' \-]{1,40}?) (\d+) \/ (\d+) recorded flights/g;
  for (const match of countries.matchAll(airspaceRe)) {
    const country = match[1].trim();
    if (seenCountries.has(country)) continue;
    seenCountries.add(country);
    airspace.push({
      country,
      flights_in: Number(match[2]),
      flights_total: Number(match[3]),
    });
  }

  const circle = text.match(/Great-circle distance The shortest distance (\d+) miles/);
  return {
    url: `https://www.flightpaths.com/${code}`,
    recorded_flights: Number(recorded[1]),
    km_min: Math.round(Number(recorded[2]) * MI_TO_KM),
    km_max: Math.round(Number(recorded[3]) * MI_TO_KM),
    great_circle_km: circle ? Math.round(Number(circle[1]) * MI_TO_KM) : null,
    air_india: airlines,
    airspace,
  };
}

async function fetchCode(code) {
  const file = path.join(CACHE, `${code}.html`);
  if (fs.existsSync(file)) {
    const cached = fs.readFileSync(file, "utf8");
    return cached || null;
  }
  const response = await fetch(`https://www.flightpaths.com/${code}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(30000),
    redirect: "follow",
  });
  const html = response.status === 200 ? await response.text() : "";
  fs.writeFileSync(file, html);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return html || null;
}

async function lookup(origin, destination) {
  for (const code of [`${origin}-${destination}`, `${destination}-${origin}`]) {
    const html = await fetchCode(code);
    if (!html) continue;
    const parsed = parse(html, code);
    if (!parsed) continue;
    parsed.matched_direction = code === `${origin}-${destination}` ? "same" : "reverse";
    return parsed;
  }
  return null;
}

function printSpot(pairs) {
  for (const key of SPOT) {
    const value = pairs[key];
    if (!value) {
      console.log(`spot ${key}: no commercial route record`);
      continue;
    }
    const names = value.air_india.map((item) => item.airline).join(", ") || "none";
    const numbers = value.air_india.flatMap((item) => item.flight_numbers);
    console.log(
      `spot ${key}: ${value.recorded_flights} flights, ${value.km_min}–${value.km_max} km, great-circle ${value.great_circle_km} km, ${value.matched_direction}, Air India: ${names} [${numbers.slice(0, 8).join(", ")}]`
    );
  }
}

function assertSpot(pairs) {
  for (const key of ["DEL-JFK", "DEL-LHR", "DEL-SIN"]) {
    const value = pairs[key];
    if (!value || !value.recorded_flights) {
      console.error(`spot-check failed for ${key}: recorded-flight sentence did not parse`);
      process.exitCode = 1;
      return false;
    }
  }
  if (!pairs["DEL-LHR"] || pairs["DEL-LHR"].air_india.length === 0) {
    console.error("spot-check failed for DEL-LHR: Air India was not parsed");
    process.exitCode = 1;
    return false;
  }
  return true;
}

async function main() {
  const sample = process.argv[2] === "--sample" ? process.argv[3] : "";
  if (sample) {
    const code = process.argv[4] || "SAMPLE";
    const parsed = parse(fs.readFileSync(sample, "utf8"), code);
    console.log(JSON.stringify(parsed, null, 2));
    if (!parsed || !parsed.air_india.length) process.exit(1);
    return;
  }

  fs.mkdirSync(CACHE, { recursive: true });
  const trips = loadTrips(fs.readFileSync(HTML_PATH, "utf8"));
  const routes = directedPairs(trips);
  for (const key of SPOT) {
    const [origin, destination] = key.split("-");
    if (!routes.some(([a, b]) => a === origin && b === destination)) routes.push([origin, destination]);
  }

  const pairs = {};
  let index = 0;
  for (const [origin, destination] of routes) {
    index += 1;
    const key = `${origin}-${destination}`;
    console.log(`fetching ${index}/${routes.length} ${origin} ${destination}`);
    try {
      pairs[key] = await lookup(origin, destination);
    } catch (error) {
      console.log(`  failed: ${error.message}`);
      pairs[key] = null;
    }
  }

  printSpot(pairs);
  if (!assertSpot(pairs)) return;

  let estimatedReturns = 0;
  for (const [key, estimate] of returnEstimates(trips)) {
    if (pairs[key] && pairs[key].recorded_flights) continue;
    pairs[key] = estimate;
    estimatedReturns += 1;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const found = Object.values(pairs).filter((value) => value && !value.estimated).length;
  const withAirIndia = Object.values(pairs).filter((value) => value && value.air_india.length).length;
  const payload = {
    source: "https://www.flightpaths.com",
    note: "Commercial passenger comparison for the same airport pair. Air India One and Indian Air Force flights are not included. Closing return legs without a commercial record are marked estimated and use the great-circle distance.",
    generated_at: new Date().toISOString(),
    pairs,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`done: ${found}/${Object.keys(pairs).length} pairs matched, ${estimatedReturns} estimated returns, ${withAirIndia} with Air India -> ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
