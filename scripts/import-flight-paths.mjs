#!/usr/bin/env node
/**
 * Extract the actual flight tracks that flightpaths.com embeds in the cached
 * pages under ./fp_cache and write them to data/flight-paths.json.
 *
 *   npm run import:paths
 *
 * The tracker uses these tracks for the 3D/2D route geometry. Airport pairs
 * without a cached track fall back to the great-circle arc in the page itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "fp_cache");
const OUT = path.join(ROOT, "data", "flight-paths.json");
const MAX_POINTS = 160;

function extractRoutes(html) {
  const match = /let\s+routes\s*=\s*\[/.exec(html);
  if (!match) return [];
  const start = html.indexOf("[", match.index);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return [];
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return [];
  }
}

function simplify(points, limit) {
  if (points.length <= limit) return points;
  const out = [];
  for (let i = 0; i < limit; i++) {
    const index = Math.round((i * (points.length - 1)) / (limit - 1));
    out.push(points[index]);
  }
  return out;
}

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const files = fs
    .readdirSync(CACHE)
    .filter((file) => file.endsWith(".html"))
    .sort();
  const pairs = {};
  let routeCount = 0;

  for (const file of files) {
    const html = fs.readFileSync(path.join(CACHE, file), "utf8");
    for (const route of extractRoutes(html)) {
      let raw;
      try {
        raw = JSON.parse(route.path_data || "[]");
      } catch {
        continue;
      }
      if (raw.length < 2) continue;
      const points = raw
        .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
        .map((point) => [
          Math.round(point.latitude * 10000) / 10000,
          Math.round(point.longitude * 10000) / 10000,
          Math.round(Number(point.altitude) || 0),
        ]);
      if (points.length < 2) continue;

      routeCount += 1;
      const key = `${route.iata_from}-${route.iata_to}`;
      const existing = pairs[key];
      // A complete recording starts near the ground and ends near the ground.
      // Cached data occasionally contains aborted flights (e.g. a loop back to
      // the departure airport) or tracks that stop at cruise altitude.
      const complete = points[0][2] < 100 && points[points.length - 1][2] < 100;
      const candidate = {
        flight: route.flight || null,
        carrier: route.carrier || null,
        airline: route.airline?.carrier_name || null,
        date: route.flight_date || null,
        actual_distance: route.actual_distance ?? null,
        complete,
        points: simplify(points, MAX_POINTS),
      };
      // Prefer a complete recording, then the longest route, then the most
      // recorded points, then the latest date.
      if (existing) {
        const better =
          (candidate.complete && !existing.complete) ||
          (candidate.complete === existing.complete &&
            ((candidate.actual_distance || 0) > (existing.actual_distance || 0) ||
              ((candidate.actual_distance || 0) === (existing.actual_distance || 0) &&
                (candidate.points.length > existing.points.length ||
                  (candidate.points.length === existing.points.length &&
                    candidate.date >= existing.date)))));
        if (!better) continue;
      }
      pairs[key] = candidate;
    }
  }

  const payload = {
    source: "https://www.flightpaths.com",
    note: "Actual tracks recorded by flightpaths.com and cached in fp_cache. Airport pairs without a track use the great-circle fallback in the tracker.",
    generated_at: new Date().toISOString(),
    pairs,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(
    `wrote ${Object.keys(pairs).length} flight tracks (${routeCount} recordings) -> ${OUT}`
  );
}

main();
