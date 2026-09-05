#!/usr/bin/env node
// Fetches award seat data from AwardFares' anonymous/free search API
// (https://awardfares.com/api/anonymous/fares.json), which backs the public
// search page at https://awardfares.com/search?ORIGIN.DEST.FROM:TO;z:sas.
// Uses a real (headless) browser via Camoufox (an anti-fingerprinted
// Firefox build on top of Playwright) to pick up Cloudflare session
// cookies first (mirroring fetch-roamsnap-data.mjs), then issues
// same-origin fetch() calls from within the page for each home<->NYC
// combo/direction.
//
// IMPORTANT LIMITATION: for anonymous (non-paid) requests this API caps
// total results to ~5 fares per (origin, destination, exactDates) query no
// matter how wide the date range is — confirmed by testing a 31-day vs.
// 400-day window and getting `total: 5` either way. So coverage here is
// inherently partial (best-effort), unlike SAS/awardhacks.se/roamsnap.com.
// Each returned fare's `previousAvailability` field (its last-known cabin
// seat counts) IS included in the API response even though the search page
// UI shows every cabin badge as "locked" for anonymous/free users — the UI
// hides it client-side only, the API itself does not gate it. Writes
// docs/data/latest-awardfares.json in the SAME shape as docs/data/latest.json.

import { mkdir, rename, writeFile, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
import { createRequire } from "node:module";
const { Camoufox } = createRequire(import.meta.url)("camoufox");

const OUTPUT_PATH = new URL("../docs/data/latest-awardfares.json", import.meta.url);
const API_URL = "https://awardfares.com/api/anonymous/fares.json";
const WARMUP_URL = "https://awardfares.com/search?ARN.EWR.z:sas";
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
// The API caps total results regardless of window width (see note above),
// but a wider window still gives it more candidate dates to pick the
// soonest matches from — 370 days covers a full SAS EuroBonus booking window.
const DAYS_AHEAD = 370;

// Same combos as fetch-sas-data.mjs: home (Nordic) airports we're willing to
// fly home to, and the New York airports we might fly out of. AwardFares'
// API takes one origin/destination pair per request, so each combo needs
// two calls (outbound: home->nyc, inbound: nyc->home).
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

function buildExactDates() {
  const dates = [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + 1); // from tomorrow
  for (let i = 0; i < DAYS_AHEAD; i++) {
    dates.push(new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return dates;
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

/** Aggregates same-date fares (e.g. two flights on one day) into one entry. */
function buildAvailabilityList(fares) {
  const byDate = new Map();
  for (const fare of fares || []) {
    if (typeof fare.date !== "string") continue;
    const prev = fare.previousAvailability || {};
    const AG = typeof prev.economy === "number" ? prev.economy : 0;
    const AP = typeof prev.premeco === "number" ? prev.premeco : 0;
    const AB = typeof prev.business === "number" ? prev.business : 0;
    const checkedAt = fare.updatedAt || fare.foundAt || null;
    const existing = byDate.get(fare.date);
    if (!existing) {
      byDate.set(fare.date, {
        date: fare.date,
        AG,
        AP,
        AB,
        availableSeatsTotal: AG + AP + AB,
        flightNumbers: fare.flight ? [fare.flight] : [],
        checkedAt,
      });
      continue;
    }
    existing.AG += AG;
    existing.AP += AP;
    existing.AB += AB;
    existing.availableSeatsTotal += AG + AP + AB;
    if (fare.flight && !existing.flightNumbers.includes(fare.flight)) existing.flightNumbers.push(fare.flight);
    if (checkedAt && (!existing.checkedAt || checkedAt > existing.checkedAt)) existing.checkedAt = checkedAt;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Calls the anonymous fares API for one origin/destination leg via a
 * same-origin in-page fetch() (real browser, Cloudflare cookies already set
 * by the warm-up page load). */
async function fetchLeg(page, origin, destination, exactDates) {
  const body = {
    origin: [`airport:${origin}`],
    destination: [`airport:${destination}`],
    ffp: ["sas"],
    flight: "",
    exactFlight: "",
    times: {},
    sort: { value: "duration", order: "a" },
    exactDates,
  };
  const result = await page.evaluate(
    async ({ apiUrl, body }) => {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, text };
    },
    { apiUrl: API_URL, body }
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

  return Array.isArray(json.fares) ? json.fares : [];
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

// Cloudflare's challenge appears probabilistic (it let requests through
// during local testing but hard-blocked every leg on the first CI run), so
// a full-outage attempt is worth retrying with a fresh browser session
// rather than giving up immediately, mirroring fetch-sas-data.mjs.
const MAX_ATTEMPTS = 3;

/** One full attempt: fresh browser + warm-up + every leg fetched once.
 * Returns a Promise.allSettled-shaped array aligned with ALL_LEGS. */
async function fetchAllOnce(exactDates) {
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
    // "networkidle" never resolves here (continuous analytics/chat-widget
    // beacons keep the network "busy" forever, like SAS's warm-up page) — use
    // "load" instead, same as fetch-sas-data.mjs.
    await page.goto(WARMUP_URL, { waitUntil: "load", timeout: TIMEOUT_MS });

    // Cloudflare's JS challenge can still be resolving after "load" — poll a
    // few times, giving it time to auto-solve and swap in the real app.
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
        const fares = await fetchLeg(page, origin, destination, exactDates);
        settled.push({ status: "fulfilled", value: fares });
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
  const exactDates = buildExactDates();

  let settled;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      settled = await fetchAllOnce(exactDates);
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
    console.error("All legs failed on every attempt. Aborting without touching the existing data/latest-awardfares.json.");
    process.exitCode = 1;
    return;
  }

  const previous = failures.length > 0 ? await readJsonIfExists(OUTPUT_PATH) : null;
  const legFares = new Map(); // "ORIGIN-DEST" -> fares[]
  ALL_LEGS.forEach(([origin, destination], i) => {
    const result = settled[i];
    if (result.status === "fulfilled") {
      legFares.set(legId(origin, destination), result.value);
    } else {
      console.error(`Failed to fetch leg "${legId(origin, destination)}": ${result.reason.message} — keeping previous data for it, if any.`);
      legFares.set(legId(origin, destination), null); // signal "fall back to previous" below
    }
  });

  const routes = {};
  for (const home of HOME_AIRPORTS) {
    for (const nyc of NYC_AIRPORTS) {
      const id = comboId(home, nyc);
      const previousEntry = previous && previous.routes && previous.routes[id];
      const previousAvailability = previousEntry && previousEntry.response && previousEntry.response[0] && previousEntry.response[0].availability;

      const outboundFares = legFares.get(legId(home, nyc));
      const inboundFares = legFares.get(legId(nyc, home));
      const outbound = outboundFares !== null ? buildAvailabilityList(outboundFares) : (previousAvailability && previousAvailability.outbound) || [];
      const inbound = inboundFares !== null ? buildAvailabilityList(inboundFares) : (previousAvailability && previousAvailability.inbound) || [];

      routes[id] = {
        origin: home,
        destination: nyc,
        source: "awardfares.com",
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
    updatedAt: new Date().toISOString(),
    routes,
  };

  await writeAtomic(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  const totalFareCount = [...legFares.values()].reduce((sum, fares) => sum + (fares ? fares.length : 0), 0);
  console.log(
    `Wrote ${OUTPUT_PATH.pathname} (parsed ${totalFareCount} fares from awardfares.com across ${ALL_LEGS.length - failures.length}/${ALL_LEGS.length} legs)`
  );
}

main().catch((err) => {
  console.error("Unexpected failure:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
