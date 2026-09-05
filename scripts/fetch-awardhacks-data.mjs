#!/usr/bin/env node
// Fetches community-reported SAS business award availability from
// awardhacks.se/List (a plain server-rendered HTML page, no JS/Cloudflare
// challenge involved — unlike SAS's own BFF, so a simple fetch() is enough)
// and writes docs/data/latest-awardhacks.json in the SAME shape as
// docs/data/latest.json (see fetch-sas-data.mjs), so the existing frontend
// rendering code can read either file unmodified. Only the "AB" (business)
// cabin is ever populated here — awardhacks.se only tracks business award
// seats — AG/AP are always 0.

import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_PATH = new URL("../docs/data/latest-awardhacks.json", import.meta.url);
const LIST_URL = "https://awardhacks.se/List";
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Same combos as fetch-sas-data.mjs: home (Nordic) airports we're willing to
// fly home to, and the New York airports we might fly out of.
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];

function comboId(home, nyc) {
  return `${home.toLowerCase()}-${nyc.toLowerCase()}`;
}

/** Parses "2026-08-31 13:46:44 UTC" into an ISO-8601 instant string. */
function parseCheckedAt(title) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec((title || "").trim());
  return m ? `${m[1]}T${m[2]}Z` : null;
}

/**
 * Walks the page in document order, remembering which "<h3>ORIGIN-DEST</h3>"
 * section each subsequent availability row belongs to. Rows for
 * origin/destination pairs we don't care about (e.g. CPH-ATL) are skipped.
 * Returns a map of routeKey ("ORIGIN-DEST") -> array of {date, seats,
 * flightNumber, checkedAt}, plus the total count of "<h3>" sections seen (as
 * a sanity check that parsing actually matched the page's structure).
 */
function parseAwardhacksHtml(html) {
  const blockRe =
    /<h3>([A-Z]{3})-([A-Z]{3})\s*<\/h3>|<div data-toggle="tooltip" title="Checked on ([^"]+)">\s*<a href="([^"]*?)">(\d{4}-\d{2}-\d{2}):\s*(\d+)<\/a>/g;

  const routeRows = new Map();
  let sectionCount = 0;
  let currentKey = null;
  let match;
  while ((match = blockRe.exec(html)) !== null) {
    const [, h3Origin, h3Dest, checkedTitle, href, date, seats] = match;
    if (h3Origin && h3Dest) {
      sectionCount += 1;
      currentKey = `${h3Origin}-${h3Dest}`;
      continue;
    }
    if (!currentKey) continue; // row before any h3 — shouldn't happen
    const flightMatch = /out_flight_number=([A-Z0-9]+)/.exec(href || "");
    if (!routeRows.has(currentKey)) routeRows.set(currentKey, []);
    routeRows.get(currentKey).push({
      date,
      seats: Number(seats),
      flightNumber: flightMatch ? flightMatch[1] : null,
      checkedAt: parseCheckedAt(checkedTitle),
    });
  }
  return { routeRows, sectionCount };
}

/** Aggregates same-date rows (e.g. two flights on one day) into one entry. */
function buildAvailabilityList(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    const existing = byDate.get(row.date);
    if (!existing) {
      byDate.set(row.date, {
        date: row.date,
        AG: 0,
        AP: 0,
        AB: row.seats,
        availableSeatsTotal: row.seats,
        flightNumbers: row.flightNumber ? [row.flightNumber] : [],
        checkedAt: row.checkedAt,
      });
      continue;
    }
    existing.AB += row.seats;
    existing.availableSeatsTotal += row.seats;
    if (row.flightNumber && !existing.flightNumbers.includes(row.flightNumber)) {
      existing.flightNumbers.push(row.flightNumber);
    }
    if (row.checkedAt && (!existing.checkedAt || row.checkedAt > existing.checkedAt)) {
      existing.checkedAt = row.checkedAt;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildRoutes(routeRows) {
  const routes = {};
  for (const home of HOME_AIRPORTS) {
    for (const nyc of NYC_AIRPORTS) {
      const outbound = buildAvailabilityList(routeRows.get(`${home}-${nyc}`));
      const inbound = buildAvailabilityList(routeRows.get(`${nyc}-${home}`));
      routes[comboId(home, nyc)] = {
        origin: home,
        destination: nyc,
        source: "awardhacks.se",
        endpoint: LIST_URL,
        status: "ok",
        response: [
          {
            airportCode: nyc,
            availability: { outbound, inbound },
          },
        ],
      };
    }
  }
  return routes;
}

async function fetchListPage() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(LIST_URL, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`non-2xx response ${res.status} from ${LIST_URL} — body: ${body.slice(0, 300)}`);
  }
  return body;
}

async function writeAtomic(path, contents) {
  const dir = dirname(fileURLToPath(path));
  await mkdir(dir, { recursive: true });
  const tmpPath = new URL(`${path.pathname}.${process.pid}.tmp`, path);
  await writeFile(tmpPath, contents, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

async function main() {
  const html = await fetchListPage();
  const { routeRows, sectionCount } = parseAwardhacksHtml(html);

  // If we didn't find a single "<h3>ORIGIN-DEST</h3>" section, the page's
  // markup has likely changed (or we got blocked/served something else) —
  // don't overwrite existing data with an empty result.
  if (sectionCount === 0) {
    throw new Error(
      `parsed 0 route sections from ${LIST_URL} — page structure may have changed; leaving existing data/latest-awardhacks.json untouched`
    );
  }

  const routes = buildRoutes(routeRows);
  const payload = {
    updatedAt: new Date().toISOString(),
    sourceUrl: LIST_URL,
    routes,
  };

  await writeAtomic(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH.pathname} (parsed ${sectionCount} route sections from awardhacks.se)`);
}

main().catch((err) => {
  console.error("Unexpected failure:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
