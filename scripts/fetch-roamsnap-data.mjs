#!/usr/bin/env node
// Fetches SAS EuroBonus RETURN (New York -> Nordic hub) business-award
// availability from RoamSnap's public awards table
// (https://roamsnap.com/awards?...&m=from). A plain fetch() gets back a
// generic ~320KB Next.js app-shell with NO table/row data at all — verified
// in CI: byte-for-byte identical response length regardless of the `dest`
// query param, and no trace of "Book on SAS" anywhere in the body.
// RoamSnap only renders the real per-request table for genuine
// JS-executing browsers (a client-side bot-check), so this uses a real
// (headless) browser via Camoufox (an anti-fingerprinted Firefox build on
// top of Playwright), like fetch-sas-data.mjs. Writes
// docs/data/latest-roamsnap.json in the SAME shape as docs/data/latest.json
// so the existing frontend rendering code works unchanged. Only the
// "inbound" (NYC -> home) leg is scraped — "outbound" is always an empty
// array. Only "AB" (business) is ever populated, since every request here
// uses cabin=BUSINESS.

import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
import { createRequire } from "node:module";
const { Camoufox } = createRequire(import.meta.url)("camoufox");

const OUTPUT_PATH = new URL("../docs/data/latest-roamsnap.json", import.meta.url);
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;

// Same combos as fetch-sas-data.mjs: home (Nordic) airports we're willing to
// fly home to, and the New York airports we might fly out of. RoamSnap's
// "awards" page takes a single `dest` (NYC-area airport) per request and
// returns all matching `hub` (home) rows for that one page, so we fetch
// once per NYC airport rather than once per home<->NYC pair.
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];

function comboId(home, nyc) {
  return `${home.toLowerCase()}-${nyc.toLowerCase()}`;
}

function buildUrl(nyc) {
  const params = new URLSearchParams({
    hub: HOME_AIRPORTS.join(","),
    cabin: "BUSINESS",
    dest: nyc,
    m: "from", // "from" = the Return tab (NYC -> home), matching the URL the user shared
  });
  return `https://roamsnap.com/awards?${params.toString()}`;
}

/**
 * Regex-walks each `<tr class="border-b border-border">...</tr>` in the
 * Return table's body, pulling the destination hub and seat count from the
 * cells, plus the flight number and origin/destination/date encoded in the
 * "Book on SAS" link's `search=OW_ORIGIN-DEST-YYYYMMDD..
 * out_flight_number=..` query string — far more reliable than parsing the
 * human-readable "Wed, 2 Sept 2026" date text in the first cell.
 */
function parseReturnRows(html, expectedOrigin) {
  const rowRe = /<tr class="border-b border-border">([\s\S]*?)<\/tr>/g;
  const hrefRe =
    /href="[^"]*?search=OW_([A-Z]{3})-([A-Z]{3})-(\d{4})(\d{2})(\d{2})[^"]*?out_flight_number=([A-Z0-9]+)[^"]*"/;
  const seatsRe = /whitespace-nowrap text-right"\s+style="color:[^"]*">(\d+)\+?<\/td>/;

  const rowsByHub = new Map();
  let rowCount = 0;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    rowCount += 1;
    const row = match[1];
    const hrefMatch = hrefRe.exec(row);
    const seatsMatch = seatsRe.exec(row);
    if (!hrefMatch || !seatsMatch) continue; // unexpected row shape — skip rather than guess
    const [, origin, hub, y, mo, d, flightNumber] = hrefMatch;
    if (origin !== expectedOrigin || !HOME_AIRPORTS.includes(hub)) continue;
    if (!rowsByHub.has(hub)) rowsByHub.set(hub, []);
    rowsByHub.get(hub).push({ date: `${y}-${mo}-${d}`, seats: Number(seatsMatch[1]), flightNumber });
  }
  return { rowsByHub, rowCount };
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
      });
      continue;
    }
    existing.AB += row.seats;
    existing.availableSeatsTotal += row.seats;
    if (row.flightNumber && !existing.flightNumbers.includes(row.flightNumber)) {
      existing.flightNumbers.push(row.flightNumber);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Navigates a real browser tab to the Return page for one NYC airport and
 * pulls out just the results table's body — RoamSnap only renders the real
 * per-request table for JS-executing browsers, so a plain fetch() won't do. */
async function fetchReturnPage(page, nyc) {
  const url = buildUrl(nyc);
  let response;
  try {
    response = await page.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
  } catch (err) {
    throw new Error(`[${nyc}] navigation error for ${url}: ${err && err.message ? err.message : err}`);
  }
  const status = response ? response.status() : null;
  if (status !== null && (status < 200 || status >= 300)) {
    throw new Error(`[${nyc}] non-2xx response ${status} from ${url}`);
  }
  const tbodyHtml = await page.evaluate(() => document.querySelector("table tbody")?.outerHTML || null);
  const hasNoResultsMessage = await page.evaluate(() =>
    Array.from(document.querySelectorAll("p")).some((p) => /no (award|round-trip)/i.test(p.textContent || ""))
  );
  return { url, status, tbodyHtml, hasNoResultsMessage };
}

/** Summarizes a fetched page for the zero-rows error message — helps tell
 * a real markup change apart from a bot-check/challenge page served with
 * a 200 status. */
function describeFetch({ status, tbodyHtml, hasNoResultsMessage }) {
  return (
    `status=${status} hasTable=${Boolean(tbodyHtml)} hasNoResultsMessage=${hasNoResultsMessage} ` +
    `length=${tbodyHtml ? tbodyHtml.length : 0}`
  );
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
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  // Camoufox is a hardened, anti-fingerprinted Firefox build (real
  // binary-level patches, not just JS property overrides), so it replaces
  // both the chromium.launch() call and the old manual
  // context.addInitScript() webdriver/plugins spoofing below. `geoip: true`
  // is deliberately omitted — it's broken in camoufox 0.1.19 (always routes
  // its IP lookup through an HttpsProxyAgent even with no proxy configured,
  // throwing "Failed to get IP address" and aborting the whole launch).
  const browser = await Camoufox({
    headless: true,
    os: "windows",
    locale: "en-US",
    humanize: true,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  console.log(`Launched browser: ${browser.version()}`);

  try {
    const page = await browser.newPage();

    const perNyc = {};
    let totalRowCount = 0;
    for (const nyc of NYC_AIRPORTS) {
      const fetched = await fetchReturnPage(page, nyc);
      const { rowsByHub, rowCount } = fetched.tbodyHtml
        ? parseReturnRows(fetched.tbodyHtml, nyc)
        : { rowsByHub: new Map(), rowCount: 0 };
      perNyc[nyc] = { url: fetched.url, rowsByHub, fetched };
      totalRowCount += rowCount;
    }

    // If neither page contained a single recognizable table row (and neither
    // showed an explicit "no results" message either), RoamSnap's markup has
    // likely changed (or we got blocked/served something else) — don't
    // overwrite existing data with an empty result.
    const anyConfirmedEmpty = NYC_AIRPORTS.some((nyc) => perNyc[nyc].fetched.hasNoResultsMessage);
    if (totalRowCount === 0 && !anyConfirmedEmpty) {
      const details = NYC_AIRPORTS.map((nyc) => `[${nyc}] ${describeFetch(perNyc[nyc].fetched)}`).join(" | ");
      throw new Error(
        `parsed 0 table rows from roamsnap.com across both NYC airports — page structure may have changed, or requests are being blocked/challenged; leaving existing data/latest-roamsnap.json untouched. ${details}`
      );
    }

    const routes = {};
    for (const home of HOME_AIRPORTS) {
      for (const nyc of NYC_AIRPORTS) {
        const inbound = buildAvailabilityList(perNyc[nyc].rowsByHub.get(home));
        routes[comboId(home, nyc)] = {
          origin: home,
          destination: nyc,
          source: "roamsnap.com",
          endpoint: perNyc[nyc].url,
          status: "ok",
          response: [
            {
              airportCode: nyc,
              availability: { outbound: [], inbound },
            },
          ],
        };
      }
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      routes,
    };

    await writeAtomic(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH.pathname} (parsed ${totalRowCount} table rows from roamsnap.com)`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Unexpected failure:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
