#!/usr/bin/env node
// Fetches SAS award-finder availability for JFK/EWR <-> ARN/OSL/CPH and
// writes docs/data/latest.json (the file the static frontend reads). Uses a
// real (headless) browser via Camoufox (an anti-fingerprinted Firefox build
// on top of Playwright) so SAS's Cloudflare bot challenge is solved fresh
// on every run, instead of a static cookie/header that would expire within
// minutes.

import { mkdir, rename, writeFile, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// camoufox's ESM build crashes under Node's ESM loader ("Dynamic require of
// \"events\" is not supported", a broken esbuild bundle of its `keyv`
// dependency) — load its working CJS build instead via createRequire.
import { createRequire } from "node:module";
const { Camoufox } = createRequire(import.meta.url)("camoufox");

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = new URL("../docs/data/latest.json", import.meta.url);
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
// Visiting this first lets the browser solve SAS's Cloudflare challenge and
// pick up the resulting session cookies before we call the BFF endpoints.
const WARMUP_URL = "https://www.sas.se/";

// Home (Nordic) airports we're willing to fly home to, and the New York
// airports we might fly out of. Every combination is fetched separately —
// "outbound" in each response is home->NYC, "inbound" is the NYC->home leg.
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];

function buildEndpoint(origin, destination) {
  return `https://www.sas.se/bff/award-finder/destinations/v1?market=se-sv&origin=${origin}&destinations=${destination}&selectedMonth=&passengers=1&direct=false&availability=true`;
}

const ROUTES = {};
for (const home of HOME_AIRPORTS) {
  for (const nyc of NYC_AIRPORTS) {
    ROUTES[`${home.toLowerCase()}-${nyc.toLowerCase()}`] = {
      origin: home,
      destination: nyc,
      endpoint: buildEndpoint(home, nyc),
    };
  }
}

/**
 * Fetches one route's endpoint via a real top-level navigation
 * (page.goto), not an in-page fetch()/XHR — the latter sends
 * `Sec-Fetch-Dest: empty` / `Sec-Fetch-Mode: cors`, which SAS's WAF started
 * hard-blocking (403 "Denied boarding") even with a warmed-up session. A
 * direct navigation sends `Sec-Fetch-Dest: document` / `Sec-Fetch-Mode:
 * navigate`, matching what a human typing/clicking their way to this URL
 * would send, while still reusing the same warmed-up browser context/cookies.
 */
async function fetchRoute(page, id, { origin, destination, endpoint }) {
  let response;
  try {
    response = await page.goto(endpoint, { referer: WARMUP_URL, timeout: TIMEOUT_MS });
  } catch (err) {
    throw new Error(`[${id}] network error fetching ${endpoint}: ${err && err.message ? err.message : err}`);
  }

  if (!response) {
    throw new Error(`[${id}] navigation to ${endpoint} produced no response (possibly treated as a download)`);
  }

  const httpStatus = response.status();
  const body = await response.text();

  if (httpStatus < 200 || httpStatus >= 300) {
    // Don't retry or work around blocks — just report the failure clearly.
    throw new Error(
      `[${id}] non-2xx response ${httpStatus} from ${endpoint}` + (body ? ` — body: ${body.slice(0, 300)}` : "")
    );
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(`[${id}] response was not valid JSON: ${err.message}`);
  }

  return {
    origin,
    destination,
    endpoint,
    status: "ok",
    httpStatus,
    response: json,
  };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// SAS's bot-check appears probabilistic, not a hard IP ban (it has let
// requests through on some runs and failed all of them on others), so a
// full-outage attempt is worth retrying with a fresh browser session rather
// than giving up after one.
const MAX_ATTEMPTS = 3;

/** One full attempt: fresh browser + warm-up + every route fetched once. */
async function fetchAllOnce(ids) {
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
    locale: "sv-SE",
    humanize: true,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  console.log(`Launched browser: ${browser.version()}`);
  try {
    const page = await browser.newPage();

    // Actually load the page (runs real JS, incl. Cloudflare's bot-check
    // beacon) so the session cookies reflect a genuine browser, not just an
    // HTTP client hitting the domain. "load" (not "networkidle") because
    // sites like this keep background requests going indefinitely, which
    // would make networkidle wait for the full timeout every time.
    await page.goto(WARMUP_URL, { waitUntil: "load", timeout: TIMEOUT_MS });

    // Give Cloudflare's async bot-check beacon time to finish and upgrade
    // the session's trust level before hitting the API — firing requests
    // the instant the page loads is itself a bot-like pattern.
    await sleep(randomDelayMs(3000, 6000));

    // Fetch one at a time with a small human-like pause between requests —
    // 6 concurrent calls across 3 different origins in one burst doesn't
    // match any real user's browsing pattern and reads as bot traffic.
    const settled = [];
    for (const id of ids) {
      if (settled.length > 0) await sleep(randomDelayMs(800, 2200));
      try {
        const value = await fetchRoute(page, id, ROUTES[id]);
        settled.push({ status: "fulfilled", value });
      } catch (reason) {
        settled.push({ status: "rejected", reason });
      }
    }
    return settled;
  } finally {
    await browser.close();
  }
}

async function main() {
  const ids = Object.keys(ROUTES);

  let settled;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    settled = await fetchAllOnce(ids);
    const failureCount = settled.filter((r) => r.status === "rejected").length;
    if (failureCount < ids.length) break; // at least partial success — stop retrying
    if (attempt < MAX_ATTEMPTS) {
      console.error(`Attempt ${attempt}/${MAX_ATTEMPTS}: every route failed, retrying with a fresh session...`);
      await sleep(randomDelayMs(30000, 60000));
    }
  }

  const failures = settled
    .map((result, i) => ({ id: ids[i], result }))
    .filter(({ result }) => result.status === "rejected");

  if (failures.length === ids.length) {
    // Nothing succeeded across every attempt — don't touch the file.
    for (const { id, result } of failures) {
      console.error(`Failed to fetch route "${id}": ${result.reason.message}`);
    }
    console.error("All routes failed on every attempt. Aborting without touching the existing data/latest.json.");
    process.exitCode = 1;
    return;
  }

  if (failures.length > 0) {
    // Partial failure: publish what succeeded, and fall back to each
    // failed route's previous data (if any) instead of losing it or
    // blocking the routes that DID succeed from being published.
    const previous = await readJsonIfExists(OUTPUT_PATH);
    for (const { id, result } of failures) {
      console.error(`Failed to fetch route "${id}": ${result.reason.message} — keeping previous data for it, if any.`);
      const idx = ids.indexOf(id);
      if (previous && previous.routes && previous.routes[id]) {
        settled[idx] = { status: "fulfilled", value: previous.routes[id] };
      } else {
        settled[idx] = {
          status: "fulfilled",
          value: { ...ROUTES[id], status: "error", error: result.reason.message },
        };
      }
    }
  }

  const routes = {};
  ids.forEach((id, i) => {
    routes[id] = settled[i].value;
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    routes,
  };

  await writeAtomic(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${OUTPUT_PATH.pathname}`);
}

main().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exitCode = 1;
});
