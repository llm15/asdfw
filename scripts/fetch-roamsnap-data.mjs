#!/usr/bin/env node
// Read Business returns from SAS airport pages: .lrow cards and cumulative
// "Show more" links. Preserve the inbound-only, Business-only data contract.
import { mkdir, rename, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const OUTPUT_PATH = new URL("../docs/data/latest-roamsnap.json", import.meta.url);
const TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS) || 30000;
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];

export function buildUrl(nyc) {
  return `https://roamsnap.com/sas/${nyc.toLowerCase()}?sdir=in`;
}

// Self-contained for serialization into the browser by page.evaluate.
export function readReturnPage() {
  const title = document.querySelector(".rhead h2")?.textContent || "";
  const totalMatch = /^\s*(\d+)\s+departures?\s*$/i.exec(title);
  return {
    total: totalMatch ? Number(totalMatch[1]) : null,
    isInbound: Boolean(document.querySelector('input[name="sdir"][value="in"]')),
    next: document.querySelector("a.more")?.getAttribute("href") || null,
    rows: Array.from(document.querySelectorAll(".lrow"), (row) => {
      const business = Array.from(row.querySelectorAll(".cabs .s")).find(
        (cell) => cell.querySelector(".mlab")?.textContent.trim() === "Business"
      );
      return {
        href: row.querySelector('a[href*="search="]')?.getAttribute("href") || "",
        flight: row.querySelector(".fn")?.textContent || "",
        business: business ? business.textContent.replace(/^\s*Business\s*/, "").trim() : null,
      };
    }),
  };
}

export function parseReturnRows(snapshot, expectedOrigin) {
  if (!snapshot.isInbound || !Number.isInteger(snapshot.total) || snapshot.total < 0) {
    throw new Error(`[${expectedOrigin}] missing return-page heading/direction; leaving existing data untouched`);
  }
  if (snapshot.rows.length > snapshot.total || (snapshot.total > 0 && snapshot.rows.length === 0)) {
    throw new Error(`[${expectedOrigin}] inconsistent departure count; leaving existing data untouched`);
  }
  const rowsByHub = new Map();
  const seen = new Set();
  for (const row of snapshot.rows) {
    const search = new URL(row.href, "https://roamsnap.com").searchParams.get("search") || "";
    const match = /^OW_([A-Z]{3})-([A-Z]{3})-(\d{4})(\d{2})(\d{2})_/.exec(search);
    const flightNumber = /\b(SK\d+)\b/.exec(row.flight)?.[1];
    const seatsMatch = /^(\d+)\+?\s*seats?$/i.exec(row.business || "");
    const empty = /^[–—-]$/.test(row.business || "");
    if (!match || !flightNumber || (!seatsMatch && !empty)) {
      throw new Error(`[${expectedOrigin}] unrecognized departure row; leaving existing data untouched`);
    }
    const [, origin, hub, y, m, d] = match;
    const date = `${y}-${m}-${d}`;
    if (origin !== expectedOrigin || !HOME_AIRPORTS.includes(hub) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error(`[${expectedOrigin}] unexpected route/date in departure row`);
    }
    const key = `${origin}-${hub}-${date}-${flightNumber}`;
    if (seen.has(key)) throw new Error(`[${expectedOrigin}] duplicate departure ${key}`);
    seen.add(key);
    const seats = seatsMatch ? Number(seatsMatch[1]) : 0;
    if (!Number.isSafeInteger(seats)) throw new Error(`[${expectedOrigin}] invalid seat count`);
    if (seats === 0) continue;
    if (!rowsByHub.has(hub)) rowsByHub.set(hub, []);
    rowsByHub.get(hub).push({ date, seats, flightNumber });
  }
  return { rowsByHub, rowCount: snapshot.rows.length };
}

export function buildAvailabilityList(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    if (!byDate.has(row.date)) {
      byDate.set(row.date, { date: row.date, AG: 0, AP: 0, AB: 0, availableSeatsTotal: 0, flightNumbers: [] });
    }
    const entry = byDate.get(row.date);
    entry.AB += row.seats;
    entry.availableSeatsTotal += row.seats;
    if (!entry.flightNumbers.includes(row.flightNumber)) entry.flightNumbers.push(row.flightNumber);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchReturnPage(page, nyc) {
  const endpoint = buildUrl(nyc);
  let url = endpoint;
  let previousCount = -1;
  const visited = new Set();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (visited.has(url)) throw new Error(`[${nyc}] repeated pagination URL`);
    visited.add(url);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    if (!response || !response.ok()) throw new Error(`[${nyc}] HTTP ${response?.status()} from ${url}`);
    await page.waitForSelector(".rhead h2", { timeout: TIMEOUT_MS });
    const snapshot = await page.evaluate(readReturnPage);
    const parsed = parseReturnRows(snapshot, nyc);
    if (parsed.rowCount <= previousCount) throw new Error(`[${nyc}] pagination made no progress`);
    previousCount = parsed.rowCount;
    if (!snapshot.next) {
      if (parsed.rowCount !== snapshot.total) throw new Error(`[${nyc}] incomplete results: ${parsed.rowCount}/${snapshot.total}`);
      // Show-more pages include earlier rows; use only the final complete page.
      return { url: endpoint, ...parsed };
    }
    const next = new URL(snapshot.next, url);
    if (next.origin !== "https://roamsnap.com" || next.pathname !== new URL(endpoint).pathname ||
        next.searchParams.get("sdir") !== "in") {
      throw new Error(`[${nyc}] unexpected pagination target`);
    }
    url = next.href;
  }
  throw new Error(`[${nyc}] pagination limit reached; leaving existing data untouched`);
}

async function writeAtomic(path, contents) {
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
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
  // camoufox 0.1.19's ESM bundle fails under Node; use its working CJS build.
  const { Camoufox } = createRequire(import.meta.url)("camoufox");
  const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const browser = await Camoufox({
    headless: true, os: "windows", locale: "en-US", humanize: true,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  console.log(`Launched browser: ${browser.version()}`);
  try {
    const page = await browser.newPage();
    const perNyc = {};
    for (const nyc of NYC_AIRPORTS) {
      perNyc[nyc] = await fetchReturnPage(page, nyc);
      console.log(`[${nyc}] parsed all ${perNyc[nyc].rowCount} departures`);
    }
    const routes = {};
    for (const home of HOME_AIRPORTS) {
      for (const nyc of NYC_AIRPORTS) {
        routes[`${home.toLowerCase()}-${nyc.toLowerCase()}`] = {
          origin: home, destination: nyc, source: "roamsnap.com",
          endpoint: perNyc[nyc].url, status: "ok",
          response: [{ airportCode: nyc, availability: {
            outbound: [], inbound: buildAvailabilityList(perNyc[nyc].rowsByHub.get(home)),
          } }],
        };
      }
    }
    await writeAtomic(OUTPUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), routes }, null, 2) + "\n");
    console.log(`Wrote ${OUTPUT_PATH.pathname}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Unexpected failure:", err?.message || err);
    process.exitCode = 1;
  });
}
