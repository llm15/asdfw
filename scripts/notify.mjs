#!/usr/bin/env node
// Sends a Telegram message when docs/data/latest.json,
// docs/data/latest-awardhacks.json and/or docs/data/latest-roamsnap.json
// contain a seat count higher than what was last notified for the same
// source/route/direction/date/cabin (see config/notify-preferences.json),
// so re-runs never repeat old news but do re-alert if more seats open up
// later. Never touches SAS, awardhacks.se or roamsnap.com itself — only
// reads the already-published data files.

import { mkdir, rename, writeFile, rm, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = new URL("../config/notify-preferences.json", import.meta.url);
const STATE_PATH = new URL("../docs/data/notified-state.json", import.meta.url);
const SOURCE_FILES = {
  sas: new URL("../docs/data/latest.json", import.meta.url),
  awardhacks: new URL("../docs/data/latest-awardhacks.json", import.meta.url),
  roamsnap: new URL("../docs/data/latest-roamsnap.json", import.meta.url),
  awardfares: new URL("../docs/data/latest-awardfares.json", import.meta.url),
  seatsaero: new URL("../docs/data/latest-seatsaero.json", import.meta.url),
};

// Same 6 home<->NYC combos tracked by fetch-sas-data.mjs / fetch-awardhacks-data.mjs.
const HOME_AIRPORTS = ["ARN", "OSL", "CPH"];
const NYC_AIRPORTS = ["JFK", "EWR"];
const COMBOS = HOME_AIRPORTS.flatMap((home) =>
  NYC_AIRPORTS.map((nyc) => ({ id: `${home.toLowerCase()}-${nyc.toLowerCase()}`, home, nyc }))
);

const CABIN_LABELS = { AG: "Economy", AP: "Premium Economy", AB: "Business" };
// Business first — it's the whole point of this tracker.
const CABIN_ORDER = ["AB", "AP", "AG"];
const SOURCE_LABELS = { sas: "SAS official", awardhacks: "Awardhacks", roamsnap: "RoamSnap", awardfares: "AwardFares", seatsaero: "seats.aero" };
// "inbound" = NYC -> home. Used only when config.directions is absent.
const DEFAULT_DIRECTIONS = ["outbound", "inbound"];

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
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

function cabinCount(entry, cabin) {
  return typeof entry[cabin] === "number" ? entry[cabin] : 0;
}

/** Finds the response entry for the requested NYC airport within one route's payload. */
function findEntry(route, nycCode) {
  if (!route || route.status !== "ok" || !Array.isArray(route.response)) return null;
  return (
    route.response.find((item) => item && typeof item.airportCode === "string" && item.airportCode.toUpperCase() === nycCode) ||
    route.response.find((item) => item && typeof item.airportCode === "string") ||
    null
  );
}

function collectMatches(source, payload, config) {
  const matches = [];
  if (!payload || typeof payload !== "object" || typeof payload.routes !== "object") return matches;
  const directions =
    Array.isArray(config.directions) && config.directions.length > 0 ? config.directions : DEFAULT_DIRECTIONS;

  for (const combo of COMBOS) {
    const entry = findEntry(payload.routes[combo.id], combo.nyc);
    if (!entry || !entry.availability) continue;

    for (const direction of directions) {
      const list = Array.isArray(entry.availability[direction]) ? entry.availability[direction] : [];
      for (const dayEntry of list) {
        if (!dayEntry || typeof dayEntry.date !== "string") continue;
        if (config.earliestDate && dayEntry.date < config.earliestDate) continue;
        if (config.latestDate && dayEntry.date > config.latestDate) continue;

        for (const cabin of config.cabins) {
          const count = cabinCount(dayEntry, cabin);
          if (count >= config.minSeats) {
            matches.push({ source, comboId: combo.id, home: combo.home, nyc: combo.nyc, direction, date: dayEntry.date, cabin, count });
          }
        }
      }
    }
  }
  return matches;
}

/**
 * Groups the flat match list into route -> (date, source) -> cabins, so a
 * date with several matching cabins becomes one line instead of one line
 * per cabin, and a route's dates are listed once under a shared heading
 * instead of repeating "EWR -> ARN" on every single line.
 */
function buildMessageBody(matches) {
  const routeGroups = new Map();
  for (const match of matches) {
    const [from, to] = match.direction === "outbound" ? [match.home, match.nyc] : [match.nyc, match.home];
    const routeKey = `${from} \u2192 ${to}`;
    if (!routeGroups.has(routeKey)) routeGroups.set(routeKey, new Map());
    const dateGroups = routeGroups.get(routeKey);
    const dateKey = `${match.date}|${match.source}`;
    if (!dateGroups.has(dateKey)) {
      dateGroups.set(dateKey, { date: match.date, source: match.source, cabins: new Map() });
    }
    dateGroups.get(dateKey).cabins.set(match.cabin, match.count);
  }

  const sections = [...routeGroups.keys()].sort().map((routeKey) => {
    const dateLines = [...routeGroups.get(routeKey).values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => {
        const cabinText = [...d.cabins.entries()]
          .sort((a, b) => CABIN_ORDER.indexOf(a[0]) - CABIN_ORDER.indexOf(b[0]))
          .map(([cabin, count]) => `${CABIN_LABELS[cabin]} ${count}`)
          .join(", ");
        return `\u2022 ${d.date} \u2014 ${cabinText} (${SOURCE_LABELS[d.source]})`;
      });
    return `*${routeKey}*\n${dateLines.join("\n")}`;
  });

  return sections.join("\n\n");
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID is not set — cannot send notification.");
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Telegram API error ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function main() {
  const config = await readJsonIfExists(CONFIG_PATH);
  if (!config) {
    console.error(`Missing ${CONFIG_PATH.pathname} — nothing to check.`);
    process.exitCode = 1;
    return;
  }

  const state = (await readJsonIfExists(STATE_PATH)) || {};
  const newMatches = [];

  for (const source of config.sources) {
    const payload = await readJsonIfExists(SOURCE_FILES[source]);
    for (const match of collectMatches(source, payload, config)) {
      const key = `${match.source}|${match.comboId}|${match.direction}|${match.date}|${match.cabin}`;
      const prevCount = typeof state[key] === "number" ? state[key] : 0;
      if (match.count > prevCount) {
        newMatches.push(match);
        state[key] = match.count;
      }
    }
  }

  if (newMatches.length === 0) {
    console.log("No new matches since last check.");
    return;
  }

  const header = `\u2708\ufe0f *${newMatches.length} new match${newMatches.length === 1 ? "" : "es"}*`;
  let text = `${header}\n\n${buildMessageBody(newMatches)}`;
  const MAX_CHARS = 3900; // Telegram's sendMessage limit is 4096 chars.
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}\n\n\u2026(truncated, see the full list on the site)`;
  }

  await sendTelegramMessage(text);
  console.log(`Sent Telegram notification for ${newMatches.length} new match(es).`);

  // Only persist state once the message actually sent, so a delivery
  // failure gets retried next run instead of being silently swallowed.
  await writeAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

main().catch((err) => {
  console.error("Unexpected failure:", err && err.message ? err.message : err);
  process.exitCode = 1;
});
