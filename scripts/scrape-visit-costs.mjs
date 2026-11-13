#!/usr/bin/env node
/**
 * Scrape the Prime Minister's Office table of expenses incurred on chartered
 * flights and map each row onto a tour in the tracker.
 *
 *   npm run scrape:costs
 *
 * Source: https://www.pmindia.gov.in/en/previous-foreign-visits/
 *
 * The page lists visits from 2014 through 2019 in reverse-chronological order.
 * It publishes one chartered-flight amount per visit (not per leg), and some
 * visits are marked "IAF BBJ Aircraft" with no rupee amount. Later visits are
 * not listed on that page, so their visit expenditure is merged in from
 * ./data/visit-costs-2021-2026.csv (MEA data). Multi-country visits are summed
 * to one figure per tour, with the per-country breakdown kept as components.
 * Visits without a figure in either source remain unpublished rather than
 * estimated.
 *
 * Raw HTML is cached in ./cost_cache so reruns can work offline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "The Prime Minister’s Global Tracker.html");
const CACHE_DIR = path.join(ROOT, "cost_cache");
const CACHE_PATH = path.join(CACHE_DIR, "previous-foreign-visits.html");
const OUT = path.join(ROOT, "data", "visit-costs.json");
const ADDITIONAL_CSV = path.join(ROOT, "data", "visit-costs-2021-2026.csv");
const SOURCE = "https://www.pmindia.gov.in/en/previous-foreign-visits/";
const ADDITIONAL_SOURCE = "Ministry of External Affairs (MEA) visit-expenditure data";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const PLACE_SYNONYMS = new Map([
  ["usa", "united states"],
  ["us", "united states"],
  ["united states of america", "united states"],
  ["uk", "united kingdom"],
  ["uae", "united arab emirates"],
  ["south korea", "south korea"],
  ["korea", "south korea"],
  ["russia", "russia"],
  ["slovak republic", "slovakia"],
  ["lao pdr", "laos"],
  ["brunei darussalam", "brunei"],
]);

const STOP_WORDS = new Set(["and", "of", "the", "a", "an", "republic"]);

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—");
}

function cleanText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function parseAmount(text) {
  if (!text) return null;
  if (/iaf|air\s*force|bbj/i.test(text)) return { type: "iaf", value: null };
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return { type: "unpublished", value: null };
  return { type: "amount", value: Number(digits) };
}

function parseRows(html) {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) throw new Error("No table found on the source page");
  const rows = [];
  for (const rowHtml of table[0].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...rowHtml.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((m) =>
      cleanText(m[0]),
    );
    if (cells.length < 4) continue;
    const [sNo, place, period, costText] = cells;
    if (!/^\d+$/.test(sNo) || !place || !period) continue;
    rows.push({
      s_no: Number(sNo),
      place,
      period,
      cost_text: costText || "",
      ...parseAmount(costText),
    });
  }
  return rows;
}

function loadTours(html) {
  const marker = "const D=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("const D= not found in tracker HTML");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start + marker.length; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start + marker.length, i + 1));
    }
  }
  throw new Error("Unterminated tour data");
}

function normalisePlace(place) {
  let text = place
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[&,;/·]/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [from, to] of PLACE_SYNONYMS) {
    text = text.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return new Set(
    text
      .split(" ")
      .map((word) => word.trim())
      .filter((word) => word && !STOP_WORDS.has(word)),
  );
}

function placeScore(rowPlace, tourPlace) {
  const a = normalisePlace(rowPlace);
  const b = normalisePlace(tourPlace);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap;
}

function yearFromPeriod(period) {
  const match = /(19|20)\d{2}/.exec(period);
  return match ? Number(match[0]) : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseVisitDates(text) {
  const parts = String(text)
    .split(/\s+to\s+/i)
    .map((part) => part.trim());
  const parseDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null;
  };
  const start = parseDate(parts[0]);
  const end = parts[1] ? parseDate(parts[1]) : start;
  return { start, end };
}

function parseTourDates(tour) {
  // Tracker dates are human-written ("30 November–1 December", "15 May",
  // "14–16 November 2022"), so parse month names and the day numbers near them.
  const text = String(tour.d)
    .toLowerCase()
    .replace(/[–—−]/g, " ")
    .replace(/-/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ");
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const months = [];
  tokens.forEach((token, index) => {
    if (MONTHS[token]) months.push({ index, month: MONTHS[token] });
  });
  const days = tokens
    .map((token, index) => ({ index, day: /^\d{1,2}$/.test(token) ? Number(token) : null }))
    .filter((entry) => entry.day != null);
  if (!months.length) return null;
  if (months.length === 1) {
    const before = days.filter((entry) => entry.index < months[0].index);
    if (!before.length) return null;
    return {
      start: new Date(Date.UTC(tour.y, months[0].month - 1, before[0].day)),
      end: new Date(
        Date.UTC(tour.y, months[0].month - 1, before[before.length - 1].day),
      ),
    };
  }
  const first = months[0];
  const last = months[months.length - 1];
  const before = days.filter((entry) => entry.index < first.index);
  const between = days.filter(
    (entry) => entry.index > first.index && entry.index < last.index,
  );
  if (!before.length || !between.length) return null;
  return {
    start: new Date(
      Date.UTC(tour.y, first.month - 1, before[before.length - 1].day),
    ),
    end: new Date(Date.UTC(tour.y, last.month - 1, between[between.length - 1].day)),
  };
}

function loadAdditionalRows(tours) {
  if (!fs.existsSync(ADDITIONAL_CSV)) return { rows: [], groups: [] };
  const raw = parseCsv(fs.readFileSync(ADDITIONAL_CSV, "utf8")).filter((row) =>
    row.some((cell) => cell.trim() !== ""),
  );
  if (!raw.length) return { rows: [], groups: [] };
  const header = raw.shift().map((cell) => cell.trim().toLowerCase());
  const column = (name) => header.indexOf(name);
  const yearColumn = column("year");
  const datesColumn = column("visit_dates");
  const countryColumn = column("country");
  const costColumn = column("expenditure_inr");
  const noteColumn = column("note");
  if ([yearColumn, datesColumn, countryColumn, costColumn].some((index) => index < 0)) {
    throw new Error("Additional visit-cost CSV is missing required columns");
  }
  const rows = raw
    .map((cells) => ({
      year: Number(cells[yearColumn]),
      visit_dates: cells[datesColumn].trim(),
      country: cells[countryColumn].trim(),
      cost_inr: cells[costColumn].trim() === "" ? null : Number(cells[costColumn]),
      note: noteColumn >= 0 && cells[noteColumn] ? cells[noteColumn].trim() : null,
    }))
    .filter((row) => row.year && row.visit_dates && row.country);

  // Rows that share a visit date belong to one tracker tour. Match the group
  // to a tour by year, overlapping dates and country-name overlap.
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.year}|${row.visit_dates}`;
    if (!grouped.has(key)) {
      grouped.set(key, { year: row.year, visit_dates: row.visit_dates, rows: [] });
    }
    grouped.get(key).rows.push(row);
  }
  const groups = [];
  for (const group of grouped.values()) {
    const { start, end } = parseVisitDates(group.visit_dates);
    if (!start || !end) {
      console.warn(`Unparseable additional visit dates: ${group.visit_dates}`);
      continue;
    }
    let best = null;
    for (const tour of tours) {
      if (tour.y !== group.year) continue;
      const tourDates = parseTourDates(tour);
      if (!tourDates) continue;
      if (!(start <= tourDates.end && end >= tourDates.start)) continue;
      let score = 0;
      for (const row of group.rows) score += placeScore(row.country, tour.c);
      const distance = Math.abs(start - tourDates.start);
      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { tour, score, distance };
      }
    }
    if (!best || best.score === 0) {
      console.warn(
        `Unmapped additional visit: ${group.visit_dates} (${group.rows
          .map((row) => row.country)
          .join(", ")})`,
      );
      continue;
    }
    groups.push({ ...group, tour: best.tour });
  }
  return { rows, groups };
}

function mapRowsToTours(rows, tours) {
  // Source rows are newest-first; the tracker is oldest-first.
  const chronological = [...rows].sort((a, b) => a.s_no - b.s_no).reverse();
  let pointer = 0;
  const mapped = [];
  for (const row of chronological) {
    const year = yearFromPeriod(row.period);
    let best = -1;
    let bestScore = 0;
    // Only look forward: the source is a chronological subsequence of the
    // tracker. Allow skipping tours the source does not list.
    for (let i = pointer; i < tours.length; i += 1) {
      const tour = tours[i];
      if (year && tour.y !== year) {
        if (tour.y > year) break;
        continue;
      }
      const score = placeScore(row.place, tour.c);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
      // Once we have a plausible match, stop at the first strong one so
      // repeated place names (Nepal, China, Japan...) map in order.
      if (score >= 1) break;
    }
    if (best >= 0) {
      mapped.push({ row, tourIndex: best, tour: tours[best] });
      pointer = best + 1;
    } else {
      mapped.push({ row, tourIndex: -1, tour: null });
    }
  }
  return mapped;
}

async function loadSource() {
  try {
    const response = await fetch(SOURCE, { headers: HEADERS, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!/<table/i.test(html)) throw new Error("Response did not contain a table");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, html);
    return { html, fetched: true };
  } catch (error) {
    if (!fs.existsSync(CACHE_PATH)) throw error;
    console.warn(`Fetch failed (${error.message}); using cached HTML.`);
    return { html: fs.readFileSync(CACHE_PATH, "utf8"), fetched: false };
  }
}

function fmtInr(value) {
  if (value == null) return "—";
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function fmtIndianAmount(value) {
  if (value == null) return "";
  const [whole, fraction] = String(value).split(".");
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${lastThree}`
    : lastThree;
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const round2 = (value) => Math.round(value * 100) / 100;

async function main() {
  const trackerHtml = fs.readFileSync(HTML_PATH, "utf8");
  const tours = loadTours(trackerHtml);
  const additional = loadAdditionalRows(tours);
  const { html, fetched } = await loadSource();
  const rows = parseRows(html);
  if (!rows.length) throw new Error("No cost rows parsed");

  const mapped = mapRowsToTours(rows, tours);
  const unmapped = mapped.filter((entry) => entry.tourIndex < 0);
  if (unmapped.length) {
    for (const entry of unmapped) {
      console.warn(
        `Unmapped source row ${entry.row.s_no}: ${entry.row.place} (${entry.row.period})`,
      );
    }
  }

  const byTour = new Map();
  for (const entry of mapped) {
    if (!entry.tour) continue;
    byTour.set(entry.tour.n, {
      tour_n: entry.tour.n,
      place: entry.row.place,
      period: entry.row.period,
      cost_text: entry.row.cost_text,
      cost_inr: entry.row.value,
      cost_type: entry.row.type,
      source_row: entry.row.s_no,
    });
  }

  // Merge the MEA 2021–2026 rows. The tracker shows one figure per tour, so
  // multi-country visits are summed while the per-country breakdown is kept.
  for (const group of additional.groups) {
    const components = group.rows.map((row) => ({
      country: row.country,
      visit_dates: row.visit_dates,
      cost_text: fmtIndianAmount(row.cost_inr),
      cost_inr: row.cost_inr,
      note: row.note,
    }));
    const amounts = components.filter((component) => component.cost_inr != null);
    const total = round2(
      amounts.reduce((sum, component) => sum + component.cost_inr, 0),
    );
    const partial = amounts.length < components.length;
    const provisional = components.some((component) =>
      /pending settlement|underway/i.test(component.note || ""),
    );
    const notes = [];
    const missing = components.filter((component) => component.cost_inr == null);
    if (missing.length && !missing.every((component) => component.note)) {
      notes.push(
        `Partial: ${missing
          .filter((component) => !component.note)
          .map((component) => component.country)
          .join(", ")} expenditure not disclosed.`,
      );
    }
    const componentNotes = components
      .filter((component) => component.note)
      .map((component) => `${component.country}: ${component.note}`);
    notes.push(...componentNotes);
    if (
      provisional &&
      !componentNotes.some((note) => /pending settlement/i.test(note))
    ) {
      notes.push("Some figures are provisional, pending settlement of bills.");
    }
    byTour.set(group.tour.n, {
      tour_n: group.tour.n,
      place: group.tour.c,
      period: group.visit_dates,
      cost_text: amounts.length ? fmtIndianAmount(total) : "",
      cost_inr: amounts.length ? total : null,
      cost_type: amounts.length ? "amount" : "unpublished",
      source_row: null,
      source: "MEA",
      components,
      partial: partial || undefined,
      provisional: provisional || undefined,
      note: notes.join(" ") || undefined,
    });
  }

  const firstYear = tours[0] ? tours[0].y : null;
  const lastPublishedYear = rows.reduce((max, row) => {
    const year = yearFromPeriod(row.period);
    return year && (!max || year > max) ? year : max;
  }, null);
  const additionalYears = additional.rows.map((row) => row.year);
  const additionalFirstYear = additionalYears.length ? Math.min(...additionalYears) : null;
  const additionalLastYear = additionalYears.length ? Math.max(...additionalYears) : null;

  // Make the absence of data explicit for every tour, so the tracker can show
  // "not published" instead of silently treating it as zero.
  for (const tour of tours) {
    if (byTour.has(tour.n)) continue;
    byTour.set(tour.n, {
      tour_n: tour.n,
      place: tour.c,
      period: `${tour.d} ${tour.y}`,
      cost_text: "",
      cost_inr: null,
      cost_type: "unpublished",
      source_row: null,
      note:
        additionalFirstYear && tour.y >= additionalFirstYear
          ? `No expenditure figure provided in the MEA dataset (${additionalFirstYear}–${additionalLastYear}).`
          : tour.y > lastPublishedYear
            ? `Not published on the previous-foreign-visits page (table ends ${lastPublishedYear}).`
            : "Not listed on the previous-foreign-visits page.",
    });
  }

  const entries = [...byTour.values()].sort((a, b) => a.tour_n - b.tour_n);
  const published = entries.filter((entry) => entry.cost_type === "amount");
  const iaf = entries.filter((entry) => entry.cost_type === "iaf");
  const unpublished = entries.filter((entry) => entry.cost_type === "unpublished");
  const publishedTotal = round2(
    published.reduce((sum, entry) => sum + entry.cost_inr, 0),
  );
  const pmoPublished = published.filter((entry) => entry.source !== "MEA");
  const pmoPublishedTotal = round2(
    pmoPublished.reduce((sum, entry) => sum + entry.cost_inr, 0),
  );
  const additionalPublished = published.filter((entry) => entry.source === "MEA");
  const additionalPublishedTotal = round2(
    additionalPublished.reduce((sum, entry) => sum + entry.cost_inr, 0),
  );

  const output = {
    source: SOURCE,
    title: "Previous Foreign visits — expenses incurred on chartered flights",
    currency: "INR",
    fetched_at: new Date().toISOString(),
    fetched_live: fetched,
    note:
      "The Prime Minister's Office publishes one chartered-flight amount per " +
      "visit, not per leg. Amounts below are the published visit totals; " +
      "per-leg figures in the tracker are distance-allocated estimates. " +
      "'IAF BBJ Aircraft' rows disclose no rupee amount. Visits after " +
      `${lastPublishedYear} are not listed on that page, so visit expenditure ` +
      `for ${additionalFirstYear}–${additionalLastYear} comes from the MEA ` +
      "dataset in data/visit-costs-2021-2026.csv. Multi-country visits are " +
      "summed; the per-country breakdown is kept under components.",
    table_range: {
      first_year: firstYear,
      last_year: lastPublishedYear,
      source_rows: rows.length,
    },
    additional_source: ADDITIONAL_SOURCE,
    additional_range: {
      first_year: additionalFirstYear,
      last_year: additionalLastYear,
      source_rows: additional.rows.length,
      visits: additional.groups.length,
    },
    totals: {
      tours: tours.length,
      published: published.length,
      iaf: iaf.length,
      unpublished: unpublished.length,
      published_inr: publishedTotal,
      pmo_published: pmoPublished.length,
      pmo_published_inr: pmoPublishedTotal,
      additional_published: additionalPublished.length,
      additional_published_inr: additionalPublishedTotal,
    },
    rows: mapped.map((entry) => ({
      s_no: entry.row.s_no,
      place: entry.row.place,
      period: entry.row.period,
      cost_text: entry.row.cost_text,
      cost_inr: entry.row.value,
      cost_type: entry.row.type,
      tour_n: entry.tour ? entry.tour.n : null,
    })),
    additional_rows: additional.groups.flatMap((group) =>
      group.rows.map((row) => ({
        year: row.year,
        place: row.country,
        period: row.visit_dates,
        cost_text: fmtIndianAmount(row.cost_inr),
        cost_inr: row.cost_inr,
        cost_type: row.cost_inr == null ? "unpublished" : "amount",
        note: row.note,
        tour_n: group.tour.n,
      })),
    ),
    by_tour: Object.fromEntries(entries.map((entry) => [entry.tour_n, entry])),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Scraped ${rows.length} rows from ${SOURCE}`);
  console.log(
    `Mapped ${mapped.filter((entry) => entry.tour).length}/${rows.length} rows · ` +
      `${published.length} amounts · ${iaf.length} IAF · ` +
      `${unpublished.length} tours without published cost`,
  );
  console.log(
    `Merged ${additional.rows.length} MEA rows into ${additional.groups.length} visits ` +
      `(${additionalFirstYear}–${additionalLastYear})`,
  );
  console.log(
    `Published chartered-flight total: ${fmtInr(publishedTotal)} (${published.length} visits)`,
  );
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
