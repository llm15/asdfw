#!/usr/bin/env node
// Fetches award seat data from seats.aero's public/anonymous "Explore"
// DataTables API (https://seats.aero/_api/availability_table_modern_ss),
// which backs pages like https://seats.aero/eurobonus/route/<id>.
//
// NOTE: that opaque "/route/<id>" URL does NOT actually filter to a
// specific route for anonymous/free users — it always renders the same
// generic "Europe -> Anywhere" explorer regardless of which id is in the
// URL (confirmed by inspecting the page's own API call after load). It's
// only used here as a same-origin landing page to pick up Cloudflare's
// session cookie before calling the API directly with precise filters.
//
// Anonymous/free access has two real limitations, both confirmed by testing:
//   1. The site's advertised "advanced filters" (`filter_origin_airports` /
//      `filter_destination_airports` query params) are silently ignored for
//      free users (recordsFiltered/data stay unfiltered) — but the
//      underlying DataTables per-column search (`columns[2][search][value]`
//      for origin airport / `columns[3][search][value]` for destination) IS
//      honored, so that's what's used here instead.
//   2. Free/anonymous results only cover a ~60-day forward window (PRO
//      unlocks a full year) — confirmed by the furthest returned date.
// Within that window the actual seat counts (`ys`/`ws`/`js` = economy/
// premium/business seats) ARE real numbers, not paywalled/locked like
// AwardFares' cabin badges. Writes docs/data/latest-seatsaero.json in the
// SAME shape as docs/data/latest.json.

import { mkdir, rename, writeFile, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
import { createRequire } from "node:module";
const { Camoufox } = createRequire(import.meta.url)("camoufox");

const OUTPUT_PATH = new URL("../docs/data/latest-seatsaero.json", import.meta.url);
const API_URL = "https://seats.aero/_api/availability_table_modern_ss";
const WARMUP_URL = "https://seats.aero/eurobonus/route/2UUqb8rKCfPGuKfW8aEMIH1DCTF";
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
// The API caps each page at 50 rows regardless of the requested `length` —
// confirmed by requesting length=500/-1 and always getting 50 back. A
// ~60-day free-tier window realistically never exceeds that for one route,
// but pagination is still implemented (capped at MAX_PAGES) as a safety net.
const PAGE_LENGTH = 100;
const MAX_PAGES = 5;

// Same combos as fetch-sas-data.mjs: home (Nordic) airports we're willing to
// fly home to, and the New York airports we might fly out of.
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];

const ALL_LEGS = [];
for (const home of HOME_AIRPORTS) {
  for (const nyc of NYC_AIRPORTS) {
    ALL_LEGS.push([home, nyc]);
    ALL_LEGS.push([nyc, home]);
  }
}

function comboId(home, nyc) {
  return `${home.toLowerCase()}-${nyc.toLowerCase()}`;
}

function legId(origin, destination) {
  return `${origin}-${destination}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Cloudflare's "Just a moment..." interstitial replaces the real app while
 * its JS challenge runs — same-origin fetch() calls made while it's still
 * showing get a 403 (no valid clearance cookie yet). */
async function isChallengePage(page) {
  return page.evaluate(() => /just a moment/i.test(document.title || ""));
}

/** Aggregates same-date rows (shouldn't normally happen — one row per date
 * per route — but handled defensively like the other fetch scripts). */
function buildAvailabilityList(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    if (typeof row.date !== "string") continue;
    const existing = byDate.get(row.date);
    if (!existing) {
      byDate.set(row.date, { ...row });
      continue;
    }
    existing.AG += row.AG;
    existing.AP += row.AP;
    existing.AB += row.AB;
    existing.availableSeatsTotal += row.availableSeatsTotal;
    if (row.checkedAt && (!existing.checkedAt || row.checkedAt > existing.checkedAt)) existing.checkedAt = row.checkedAt;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildParams(origin, destination, start) {
  return {
    draw: 1,
    start,
    length: PAGE_LENGTH,
    "columns[0][data]": "dt",
    "columns[1][data]": "lsh",
    "columns[2][data]": "oa",
    "columns[2][search][value]": origin,
    "columns[2][search][regex]": "false",
    "columns[3][data]": "da",
    "columns[3][search][value]": destination,
    "columns[3][search][regex]": "false",
    "columns[4][data]": "ym",
    "columns[5][data]": "wm",
    "columns[6][data]": "jm",
    "columns[7][data]": "id",
    "order[0][column]": 0,
    "order[0][dir]": "asc",
    origin_region: "Anywhere",
    destination_region: "Anywhere",
    route: "",
    origin_airport: "",
    destination_airport: "",
    carrier: "",
    source: "eurobonus",
    giga: "false",
    min_seats: 1,
    direct_only: "false",
    ex: "false",
  };
}

/** Calls the Explore API for one origin/destination leg via a same-origin
 * in-page fetch() (real browser, Cloudflare cookies already set by the
 * warm-up page load), paginating until all matching rows are collected. */
async function fetchLeg(page, origin, destination, fetchedAt) {
  const rows = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const params = buildParams(origin, destination, pageIndex * PAGE_LENGTH);
    const result = await page.evaluate(
      async ({ apiUrl, params }) => {
        const url = new URL(apiUrl);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const res = await fetch(url.toString());
        const text = await res.text();
        return { status: res.status, text };
      },
      { apiUrl: API_URL, params }
    );

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`[${origin}-${destination}] non-2xx response ${result.status} — body: ${result.text.slice(0, 300)}`);
    }

    let json;
    try {
      json = JSON.parse(result.text);
    } catch (err) {
      throw new Error(`[${origin}-${destination}] response was not valid JSON: ${err.message}`);
    }

    const data = Array.isArray(json.data) ? json.data : [];
    for (const item of data) {
      if (typeof item.dt !== "string") continue;
      const AG = typeof item.ys === "number" ? item.ys : 0;
      const AP = typeof item.ws === "number" ? item.ws : 0;
      const AB = typeof item.js === "number" ? item.js : 0;
      const checkedAt =
        typeof item.lsh === "number" ? new Date(fetchedAt.getTime() - item.lsh * 3600000).toISOString() : null;
      rows.push({ date: item.dt, AG, AP, AB, availableSeatsTotal: AG + AP + AB, checkedAt });
    }

    const total = typeof json.recordsFiltered === "number" ? json.recordsFiltered : data.length;
    if (rows.length >= total || data.length < PAGE_LENGTH) break;
  }
  return rows;
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

// Cloudflare's challenge appears probabilistic on GitHub Actions' IPs (see
// fetch-awardfares-data.mjs), so a full-outage attempt is worth retrying
// with a fresh browser session rather than giving up immediately.
const MAX_ATTEMPTS = 3;

/** One full attempt: fresh browser + warm-up + every leg fetched once.
 * Returns a Promise.allSettled-shaped array aligned with ALL_LEGS. */
async function fetchAllOnce(fetchedAt) {
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
    // "networkidle" never resolves here (continuous analytics beacons keep
    // the network "busy" forever, same issue as fetch-awardfares-data.mjs).
    await page.goto(WARMUP_URL, { waitUntil: "load", timeout: TIMEOUT_MS });

    // Cloudflare's JS challenge can still be resolving after "load" — poll
    // a few times, giving it time to auto-solve and swap in the real app.
    for (let i = 0; i < 5 && (await isChallengePage(page)); i++) {
      await sleep(3000);
    }
    if (await isChallengePage(page)) {
      console.error("Still on Cloudflare's challenge page after waiting — this attempt will likely fail.");
    }

    const settled = [];
    let first = true;
    for (const [origin, destination] of ALL_LEGS) {
      // Small human-like pause between requests — 12 calls in one burst
      // doesn't match any real user's browsing pattern.
      if (!first) await sleep(randomDelayMs(800, 2200));
      first = false;
      try {
        const rows = await fetchLeg(page, origin, destination, fetchedAt);
        settled.push({ status: "fulfilled", value: rows });
      } catch (err) {
        settled.push({ status: "rejected", reason: err });
      }
    }
    return settled;
  } finally {
    await browser.close();
  }
}

async function main() {
  const fetchedAt = new Date();

  let settled;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      settled = await fetchAllOnce(fetchedAt);
    } catch (err) {
      // A whole-attempt failure (e.g. the warm-up navigation itself timed
      // out) is equivalent to every leg failing — treat it as such so the
      // retry loop below still runs instead of crashing the whole script.
      settled = ALL_LEGS.map(() => ({ status: "rejected", reason: err }));
    }
    const failureCount = settled.filter((r) => r.status === "rejected").length;
    if (failureCount < ALL_LEGS.length) break; // at least partial success — stop retrying
    if (attempt < MAX_ATTEMPTS) {
      console.error(`Attempt ${attempt}/${MAX_ATTEMPTS}: every leg failed, retrying with a fresh session...`);
      await sleep(randomDelayMs(20000, 40000));
    }
  }

  const failures = ALL_LEGS.map((leg, i) => ({ leg, result: settled[i] })).filter(({ result }) => result.status === "rejected");

  if (failures.length === ALL_LEGS.length) {
    // Nothing succeeded across every attempt — don't touch the file.
    for (const { leg, result } of failures) {
      console.error(`Failed to fetch leg "${legId(...leg)}": ${result.reason.message}`);
    }
    console.error("All legs failed on every attempt. Aborting without touching the existing data/latest-seatsaero.json.");
    process.exitCode = 1;
    return;
  }

  const previous = failures.length > 0 ? await readJsonIfExists(OUTPUT_PATH) : null;
  const legRows = new Map(); // "ORIGIN-DEST" -> rows[]
  ALL_LEGS.forEach(([origin, destination], i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      legRows.set(legId(origin, destination), result.value);
    } else {
      console.error(`Failed to fetch leg "${legId(origin, destination)}": ${result.reason.message} — keeping previous data for it, if any.`);
      legRows.set(legId(origin, destination), null); // signal "fall back to previous" below
    }
  });

  const routes = {};
  for (const home of HOME_AIRPORTS) {
    for (const nyc of NYC_AIRPORTS) {
      const id = comboId(home, nyc);
      const previousEntry = previous && previous.routes && previous.routes[id];
      const previousAvailability = previousEntry && previousEntry.response && previousEntry.response[0] && previousEntry.response[0].availability;

      const outboundRows = legRows.get(legId(home, nyc));
      const inboundRows = legRows.get(legId(nyc, home));
      const outbound = outboundRows !== null ? buildAvailabilityList(outboundRows) : (previousAvailability && previousAvailability.outbound) || [];
      const inbound = inboundRows !== null ? buildAvailabilityList(inboundRows) : (previousAvailability && previousAvailability.inbound) || [];

      routes[id] = {
        origin: home,
        destination: nyc,
        source: "seats.aero",
        endpoint: API_URL,
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

  const payload = {
    updatedAt: fetchedAt.toISOString(),
    routes,
  };

  await writeAtomic(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  const totalRowCount = [...legRows.values()].reduce((sum, rows) => sum + (rows ? rows.length : 0), 0);
  console.log(
    `Wrote ${OUTPUT_PATH.pathname} (parsed ${totalRowCount} rows from seats.aero across ${ALL_LEGS.length - failures.length}/${ALL_LEGS.length} legs)`
  );
}

main().catch((err) => {
  console.error("Unexpected failure:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
