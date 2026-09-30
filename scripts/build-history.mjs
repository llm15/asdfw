#!/usr/bin/env node
/**
 * Appends the currently published availability to docs/data/history.json,
 * so the dashboard can answer "what changed?" and "how has this date moved?"
 * for every visitor — not just the one browser that happened to be open
 * when it changed (which is all localStorage could ever do).
 *
 * Reads only the already-published docs/data/latest*.json files; it never
 * calls SAS or any other site.
 *
 * The file is a change-point log, not a series of full snapshots: a
 * route/direction/date only gets a new point when its seat counts actually
 * differ from the last recorded ones. Timestamps are interned in `runs` and
 * referenced by index, which keeps a year of four-times-daily runs small
 * enough to serve as a static file.
 *
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-10-01T06:00:00.000Z",
 *     "runs": ["2026-09-30T18:51:35.778Z", "2026-10-01T06:00:00.000Z"],
 *     "series": { "arn-jfk|inbound|2027-05-04": [[0, 10, 1, 0], [1, 10, 0, 2]] }
 *   }
 *
 * Each point is [runIndex, AG, AP, AB]. A date that disappears records an
 * explicit all-zero point, so "gone" is distinguishable from "unchanged" —
 * but only for routes the fetch actually succeeded for, so a failed request
 * can never be mistaken for lost availability.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LATEST_PATH = new URL("../docs/data/latest.json", import.meta.url);
const HISTORY_PATH = new URL("../docs/data/history.json", import.meta.url);

export const HISTORY_VERSION = 1;
/** Four runs a day for ~three months. Older points are folded into a
 * baseline rather than dropped, so trends stay truthful after pruning. */
export const MAX_RUNS = 360;
const DIRECTIONS = ["inbound", "outbound"];
const HOME_AIRPORTS = ["arn", "osl", "cph"];
const NYC_AIRPORTS = ["jfk", "ewr"];
export const COMBO_IDS = HOME_AIRPORTS.flatMap((home) => NYC_AIRPORTS.map((nyc) => `${home}-${nyc}`));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function seatCount(entry, cabin) {
  return typeof entry[cabin] === "number" && entry[cabin] > 0 ? entry[cabin] : 0;
}

/** The response entry for the NYC airport this route was requested for. */
function findEntry(route, comboId) {
  if (!isPlainObject(route) || route.status !== "ok" || !Array.isArray(route.response)) return null;
  const nyc = comboId.split("-")[1].toUpperCase();
  return (
    route.response.find(
      (item) => isPlainObject(item) && typeof item.airportCode === "string" && item.airportCode.toUpperCase() === nyc
    ) ||
    route.response.find((item) => isPlainObject(item) && typeof item.airportCode === "string") ||
    null
  );
}

/**
 * Flattens one published payload into `route|direction|date` -> [AG, AP, AB],
 * plus the set of routes the fetch actually succeeded for. Routes that
 * failed are reported separately so their existing history is left alone
 * instead of being recorded as "availability disappeared".
 */
export function snapshotFromPayload(payload) {
  const counts = new Map();
  const okRoutes = new Set();
  if (!isPlainObject(payload) || !isPlainObject(payload.routes)) return { counts, okRoutes };

  for (const comboId of COMBO_IDS) {
    const entry = findEntry(payload.routes[comboId], comboId);
    if (!entry) continue;
    okRoutes.add(comboId);
    const availability = isPlainObject(entry.availability) ? entry.availability : {};
    for (const direction of DIRECTIONS) {
      const list = Array.isArray(availability[direction]) ? availability[direction] : [];
      for (const day of list) {
        if (!isPlainObject(day) || typeof day.date !== "string" || !ISO_DATE.test(day.date)) continue;
        const key = `${comboId}|${direction}|${day.date}`;
        if (counts.has(key)) continue; // dedupe: keep first occurrence, as the dashboard does
        counts.set(key, [seatCount(day, "AG"), seatCount(day, "AP"), seatCount(day, "AB")]);
      }
    }
  }
  return { counts, okRoutes };
}

function emptyHistory() {
  return { version: HISTORY_VERSION, updatedAt: null, runs: [], series: {} };
}

/** Accepts anything on disk and returns a structurally valid history, so a
 * truncated or hand-edited file costs at most the old points, never a crash. */
export function normalizeHistory(raw) {
  if (!isPlainObject(raw) || raw.version !== HISTORY_VERSION) return emptyHistory();
  const runs = Array.isArray(raw.runs) ? raw.runs.filter((at) => typeof at === "string") : [];
  const series = {};
  if (isPlainObject(raw.series)) {
    for (const [key, points] of Object.entries(raw.series)) {
      if (!Array.isArray(points)) continue;
      const clean = points
        .filter(
          (p) =>
            Array.isArray(p) &&
            p.length === 4 &&
            p.every((n) => Number.isInteger(n) && n >= 0) &&
            p[0] < runs.length
        )
        .sort((a, b) => a[0] - b[0]);
      if (clean.length > 0) series[key] = clean;
    }
  }
  return { version: HISTORY_VERSION, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null, runs, series };
}

function sameCounts(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Drops runs older than `maxRuns` and series whose travel date has passed.
 * The last point before the cutoff is kept, rebased to index 0, so a date
 * that stopped changing months ago still reports its current seat counts.
 */
export function pruneHistory(history, { maxRuns = MAX_RUNS, today } = {}) {
  const drop = Math.max(0, history.runs.length - maxRuns);
  const runs = drop > 0 ? history.runs.slice(drop) : history.runs;
  const series = {};

  for (const [key, points] of Object.entries(history.series)) {
    const date = key.split("|")[2];
    if (today && date < today) continue;

    const kept = [];
    for (const [index, ...counts] of points) {
      const shifted = index - drop;
      if (shifted < 0) {
        // Everything before the cutoff collapses into one baseline point.
        kept.length = 0;
        kept.push([0, ...counts]);
        continue;
      }
      if (kept.length === 1 && kept[0][0] === 0 && shifted === 0) kept.length = 0;
      kept.push([shifted, ...counts]);
    }
    // A series that only ever said "nothing here" carries no information.
    if (kept.length === 1 && sameCounts(kept[0].slice(1), [0, 0, 0])) continue;
    if (kept.length > 0) series[key] = kept;
  }

  return { ...history, runs, series };
}

/**
 * Appends one run to the history, recording a point only where the counts
 * actually changed. Returns the new history and how many changes were
 * recorded; `changed === 0` still appends the run, so "checked, nothing
 * moved" stays distinguishable from "never checked".
 */
export function appendSnapshot(history, snapshot, runIso, { maxRuns = MAX_RUNS, today } = {}) {
  const base = normalizeHistory(history);
  if (base.runs.includes(runIso)) return { history: base, changed: 0, skipped: true };

  const runIndex = base.runs.length;
  const runs = [...base.runs, runIso];
  const series = { ...base.series };
  let changed = 0;

  const lastCounts = (key) => {
    const points = series[key];
    return points && points.length > 0 ? points[points.length - 1].slice(1) : null;
  };
  const record = (key, counts) => {
    series[key] = [...(series[key] || []), [runIndex, ...counts]];
    changed += 1;
  };

  for (const [key, counts] of snapshot.counts) {
    const previous = lastCounts(key);
    if (previous && sameCounts(previous, counts)) continue;
    // A date that has only ever been empty is not worth a series of its own.
    if (!previous && sameCounts(counts, [0, 0, 0])) continue;
    record(key, counts);
  }

  // Dates that vanished from a route that answered successfully.
  for (const key of Object.keys(series)) {
    if (snapshot.counts.has(key)) continue;
    if (!snapshot.okRoutes.has(key.split("|")[0])) continue;
    const previous = lastCounts(key);
    if (!previous || sameCounts(previous, [0, 0, 0])) continue;
    record(key, [0, 0, 0]);
  }

  return {
    history: pruneHistory({ version: HISTORY_VERSION, updatedAt: runIso, runs, series }, { maxRuns, today }),
    changed,
    skipped: false,
  };
}

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
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
  const payload = await readJsonIfExists(LATEST_PATH);
  if (!payload) {
    console.error(`Missing ${fileURLToPath(LATEST_PATH)} — nothing to record.`);
    process.exitCode = 1;
    return;
  }

  // The fetch instant, not "now", so re-running the job can't invent a run.
  const runIso = typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString();
  const snapshot = snapshotFromPayload(payload);
  if (snapshot.okRoutes.size === 0) {
    console.error("Every route failed in the published payload — refusing to record a run.");
    process.exitCode = 1;
    return;
  }

  const existing = await readJsonIfExists(HISTORY_PATH);
  const today = new Date().toISOString().slice(0, 10);
  const { history, changed, skipped } = appendSnapshot(existing, snapshot, runIso, { today });

  if (skipped) {
    console.log(`History already contains the run at ${runIso} — nothing to do.`);
    return;
  }

  await writeAtomic(HISTORY_PATH, `${JSON.stringify(history)}\n`);
  console.log(
    `Recorded ${changed} change${changed === 1 ? "" : "s"} at ${runIso} ` +
      `(${history.runs.length} runs, ${Object.keys(history.series).length} tracked dates).`
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
