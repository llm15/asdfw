/**
 * NYC → Nordics Award Finder dashboard frontend.
 *
 * Covers every combination of NYC airport (JFK/EWR) and home airport
 * (ARN/OSL/CPH), since a return seat to any of the three is useful.
 *
 * This script only ever reads static, already-published JSON files (one per
 * data source — see SOURCES below) using relative URLs — automatically on
 * page load, and again whenever "Fetch latest availability" is pressed. It
 * never calls SAS, awardhacks.se, roamsnap.com, awardfares.com or
 * seats.aero directly, and never handles any token/secret. Each published
 * file is produced by a separate CI job (see scripts/fetch-*.mjs). Every
 * source's data is merged into a single calendar/table — for a given
 * route/date/cabin, the highest seat count any source reports is shown
 * (a source that hasn't checked recently, or reports a stale lower count,
 * shouldn't hide a higher count another source found), so it never matters
 * which individual site happened to have the freshest data.
 *
 * Rendering safety: every value that originates from the fetched JSON is
 * written to the DOM via `textContent`, never via `innerHTML`. This means
 * API strings can never be interpreted as markup, so no manual
 * HTML-escaping is needed — but it also means we must never switch these
 * assignments to innerHTML without re-adding escaping.
 *
 * Date handling: `date` fields in the API response are plain ISO date-only
 * strings (e.g. "2027-05-04") with no time-of-day or timezone component.
 * They are parsed and compared purely as calendar dates (via Date.UTC) and
 * formatted with an explicit `timeZone: "UTC"` so the displayed calendar
 * date can never shift because of the visitor's local timezone. Only the
 * real fetch-instant timestamp (`updatedAt`, a full ISO datetime) is ever
 * converted to an actual timezone (Europe/Stockholm).
 *
 * Data rules: only AG/AP/AB (Economy/Premium Economy/Business) seat counts
 * and availableSeatsTotal are ever displayed — no prices, points costs,
 * flight numbers or times are invented, because the API doesn't provide
 * them. A missing class on a present date is treated as 0 seats; a missing
 * date is treated as "no result returned", never as "0 seats available".
 */
(() => {
  const AUTH_PASSWORD = "pizza12";
  const AUTH_STORAGE_KEY = "awards:dashboardUnlocked";
  const MONTHLY_ACTIVITY_STORAGE_KEY = "awards:monthlyAvailabilityActivity";

  // All sources publish the exact same JSON shape (see fetch-sas-data.mjs /
  // fetch-awardhacks-data.mjs / fetch-roamsnap-data.mjs / fetch-awardfares-
  // data.mjs / fetch-seatsaero-data.mjs), so the same merge/rendering logic
  // below works unchanged for all of them. awardhacks.se, roamsnap.com and
  // seats.aero's free tier mostly only ever report the "AB" (business)
  // cabin — AG/AP are usually 0 for those sources. roamsnap.com also only
  // ever populates "inbound" (return) dates — "outbound" is always empty.
  const SOURCES = {
    sas: { url: "data/latest.json", storageKey: "awards:lastGoodPayload:sas", label: "SAS official (live)" },
    awardhacks: {
      url: "data/latest-awardhacks.json",
      storageKey: "awards:lastGoodPayload:awardhacks",
      label: "Awardhacks community (business only)",
    },
    roamsnap: {
      url: "data/latest-roamsnap.json",
      storageKey: "awards:lastGoodPayload:roamsnap",
      label: "RoamSnap (business, return only)",
    },
    awardfares: {
      url: "data/latest-awardfares.json",
      storageKey: "awards:lastGoodPayload:awardfares",
      label: "AwardFares (anonymous, partial coverage)",
    },
    seatsaero: {
      url: "data/latest-seatsaero.json",
      storageKey: "awards:lastGoodPayload:seatsaero",
      label: "seats.aero (anonymous, 60-day window)",
    },
  };
  const SOURCE_KEYS = Object.keys(SOURCES);

  // Home (Nordic) airports we're willing to fly home to, and the New York
  // airports we might fly out of. Every combination is fetched by the CI job
  // and can be shown side by side here — "I'll take a spot home to ARN, OSL,
  // or CPH, from either JFK or EWR".
  const HOME_AIRPORTS = [
    { id: "arn", code: "ARN" },
    { id: "osl", code: "OSL" },
    { id: "cph", code: "CPH" },
  ];
  const NYC_AIRPORTS = [
    { id: "jfk", code: "JFK" },
    { id: "ewr", code: "EWR" },
  ];
  const COMBOS = HOME_AIRPORTS.flatMap((home) =>
    NYC_AIRPORTS.map((nyc) => ({ id: `${home.id}-${nyc.id}`, home, nyc }))
  );

  // Priority order for picking which cabin "best" represents a mixed result.
  const CABIN_PRIORITY = ["AB", "AP", "AG"];

  const els = {
    fetchBtn: document.getElementById("fetch-btn"),
    fetchBtnLabel: document.getElementById("fetch-btn-label"),
    fetchBtnSpinner: document.getElementById("fetch-btn-spinner"),
    refreshPageBtn: document.getElementById("refresh-page-btn"),
    lastFetched: document.getElementById("last-fetched-value"),
    status: document.getElementById("status-message"),
    directionSelect: document.getElementById("direction-select"),
    monthInput: document.getElementById("month-input"),
    nycJfk: document.getElementById("nyc-jfk"),
    nycEwr: document.getElementById("nyc-ewr"),
    homeArn: document.getElementById("home-arn"),
    homeOsl: document.getElementById("home-osl"),
    homeCph: document.getElementById("home-cph"),
    cabinSelect: document.getElementById("cabin-select"),
    minSeatsInput: document.getElementById("min-seats-input"),
    includeMissingToggle: document.getElementById("include-missing-toggle"),
    allMonthsToggle: document.getElementById("all-months-toggle"),
    summary: document.getElementById("summary-cards"),
    calendarHeading: document.getElementById("calendar-heading"),
    calendar: document.getElementById("calendar"),
    prevMonthBtn: document.getElementById("prev-month-btn"),
    nextMonthBtn: document.getElementById("next-month-btn"),
    jumpEarliestBtn: document.getElementById("jump-earliest-btn"),
    jumpLatestBtn: document.getElementById("jump-latest-btn"),
    table: document.getElementById("dates-table"),
    tableMeta: document.getElementById("table-meta"),
    tableBody: document.getElementById("dates-table-body"),
    technical: document.getElementById("technical-details"),
    monthlyActivity: document.getElementById("monthly-activity"),
    dayDetailDialog: document.getElementById("day-detail-dialog"),
    dayDetailContent: document.getElementById("day-detail-content"),
    dayDetailClose: document.getElementById("day-detail-close"),
    loginDialog: document.getElementById("login-dialog"),
    loginForm: document.getElementById("login-form"),
    loginPassword: document.getElementById("login-password"),
    loginError: document.getElementById("login-error"),
  };

  const state = {
    direction: "inbound", // 'inbound' (Return: NY→home) | 'outbound' (home→NY)
    month: "2027-05",
    nycAirports: { jfk: true, ewr: true },
    homeAirports: { arn: true, osl: true, cph: true },
    cabin: "all", // 'all' | 'AG' | 'AP' | 'AB'
    minSeats: 1,
    includeMissing: false,
    allMonths: false, // when true, the table shows matches across every fetched month, not just `month`
    sort: { key: "date", dir: "asc" },
  };

  // Populated only after a successful (or fallback-to-cache) fetch of every
  // source. Nothing is fetched, and nothing is rendered as real data, until
  // then. `sourcesData` keeps each source's own normalized data (for
  // per-source technical details); `lastGood` is the merged view every
  // other render function reads from, in the SAME shape a single source
  // used to have ({ fetchedAt, routesData: { "arn-jfk": {...}, ... } }).
  let sourcesData = null; // { sas: { fetchedAt, routesData } | null, ... }
  let lastGood = null;
  // "combo.id|direction|date" -> { type, previousTotal, newTotal } for
  // dates whose merged total changed since the last time this browser
  // fetched each source (see computeAvailabilityChanges()).
  let availabilityChanges = new Map();

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function isIsoDateOnly(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /** Formats a "YYYY-MM-DD" string with no timezone-driven date shift. */
  function formatDateDisplay(dateStr) {
    if (!isIsoDateOnly(dateStr)) return String(dateStr);
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  function formatWeekday(dateStr) {
    if (!isIsoDateOnly(dateStr)) return "—";
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", weekday: "short" }).format(
      new Date(Date.UTC(y, m - 1, d))
    );
  }

  function formatMonthHeading(monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    if (!y || !m) return "Calendar";
    const label = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, 1)));
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  /** Formats a real fetch-instant ISO timestamp in actual Stockholm time. */
  function formatTimestamp(iso) {
    if (!iso) return "unknown";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  }

  function setStatus(message, variant) {
    els.status.textContent = message || "";
    if (variant) {
      els.status.setAttribute("data-variant", variant);
    } else {
      els.status.removeAttribute("data-variant");
    }
  }

  /**
   * Indexes one direction's list of day-entries by date, deduplicating on
   * date (first occurrence wins) and treating a missing cabin field as 0
   * seats. `total` prefers the reported availableSeatsTotal, only falling
   * back to a same-cabin-count sum if that field itself is absent.
   */
  function indexByDate(entries) {
    const map = new Map();
    if (!Array.isArray(entries)) return map;
    for (const entry of entries) {
      if (!isPlainObject(entry) || !isIsoDateOnly(entry.date)) continue;
      if (map.has(entry.date)) continue; // dedupe: keep first occurrence
      const AG = typeof entry.AG === "number" ? entry.AG : 0;
      const AP = typeof entry.AP === "number" ? entry.AP : 0;
      const AB = typeof entry.AB === "number" ? entry.AB : 0;
      const total =
        typeof entry.availableSeatsTotal === "number" ? entry.availableSeatsTotal : AG + AP + AB;
      map.set(entry.date, { AG, AP, AB, total });
    }
    return map;
  }

  /**
   * Builds a normalized view of one home↔NYC route, keeping the requested
   * NYC airport code separate from whatever airportCode SAS actually
   * returned, so mismatches can be surfaced rather than silently trusted.
   * The home airport isn't present in SAS's response at all — it's only
   * known because it's what we requested — so it's just passed through.
   */
  function buildRouteData(homeCode, requestedCode, route) {
    const ok = isPlainObject(route) && route.status === "ok" && Array.isArray(route.response);
    const entry = ok
      ? route.response.find(
          (item) =>
            isPlainObject(item) &&
            typeof item.airportCode === "string" &&
            item.airportCode.toUpperCase() === requestedCode.toUpperCase()
        ) ||
        route.response.find((item) => isPlainObject(item) && typeof item.airportCode === "string") ||
        null
      : null;

    const returnedCode = entry && typeof entry.airportCode === "string" ? entry.airportCode.toUpperCase() : null;
    const availability = entry && isPlainObject(entry.availability) ? entry.availability : {};

    return {
      homeCode,
      requestedCode,
      ok,
      error: isPlainObject(route) && typeof route.error === "string" ? route.error : null,
      httpStatus: isPlainObject(route) && typeof route.httpStatus === "number" ? route.httpStatus : null,
      endpoint: isPlainObject(route) && typeof route.endpoint === "string" ? route.endpoint : null,
      returnedCode,
      mismatch: Boolean(returnedCode && returnedCode !== requestedCode.toUpperCase()),
      outboundMap: indexByDate(availability.outbound),
      inboundMap: indexByDate(availability.inbound),
      rawResponse: isPlainObject(route) ? route.response : undefined,
    };
  }

  function normalizePayload(payload) {
    const fetchedAt = isPlainObject(payload) && typeof payload.updatedAt === "string" ? payload.updatedAt : null;
    const routes = isPlainObject(payload) && isPlainObject(payload.routes) ? payload.routes : {};
    const routesData = {};
    for (const combo of COMBOS) {
      routesData[combo.id] = buildRouteData(combo.home.code, combo.nyc.code, routes[combo.id]);
    }
    return { fetchedAt, routesData };
  }

  function persistPayload(sourceKey, payload) {
    try {
      localStorage.setItem(SOURCES[sourceKey].storageKey, JSON.stringify(payload));
    } catch {
      // Ignore storage errors (e.g. private browsing, quota) — this is a
      // best-effort fallback cache, not a requirement.
    }
  }

  function loadPersistedPayload(sourceKey) {
    try {
      const raw = localStorage.getItem(SOURCES[sourceKey].storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function loadMonthlyActivity() {
    try {
      const raw = localStorage.getItem(MONTHLY_ACTIVITY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveMonthlyActivity(activity) {
    try {
      localStorage.setItem(MONTHLY_ACTIVITY_STORAGE_KEY, JSON.stringify(activity));
    } catch {
      // Best-effort tracking only; the dashboard still works without it.
    }
  }

  function monthlyActivityFor(month) {
    const entry = loadMonthlyActivity()[month];
    return isPlainObject(entry)
      ? { added: Number(entry.added) || 0, lost: Number(entry.lost) || 0, updatedAt: entry.updatedAt || null }
      : { added: 0, lost: 0, updatedAt: null };
  }

  /** Persists the latest diff into a browser-local ledger keyed by travel
   * month, so repeated visits show how many seats were added or disappeared
   * for each travel month. */
  function recordMonthlyActivity(changes) {
    if (!changes || changes.size === 0) return;
    const activity = loadMonthlyActivity();
    const now = new Date().toISOString();
    for (const [key, change] of changes) {
      const dateStr = key.split("|")[2];
      if (!isIsoDateOnly(dateStr)) continue;
      const month = dateStr.slice(0, 7);
      const existing = isPlainObject(activity[month]) ? activity[month] : { added: 0, lost: 0 };
      const delta = Math.abs(change.newTotal - change.previousTotal);
      if (change.type === "increased") {
        existing.added = (Number(existing.added) || 0) + delta;
      } else {
        existing.lost = (Number(existing.lost) || 0) + delta;
      }
      existing.updatedAt = now;
      activity[month] = existing;
    }
    saveMonthlyActivity(activity);
  }

  /** Merges same-date entries from several sources' maps, keeping the
   * HIGHEST seat count any source reports per cabin — a source that hasn't
   * checked recently, or reports a stale lower count, shouldn't hide a
   * higher count another source found. */
  function mergeDateMaps(perSourceMaps) {
    const merged = new Map();
    for (const { sourceKey, map } of perSourceMaps) {
      for (const [date, counts] of map) {
        const existing = merged.get(date);
        if (!existing) {
          merged.set(date, { AG: counts.AG, AP: counts.AP, AB: counts.AB, sources: [sourceKey] });
          continue;
        }
        existing.AG = Math.max(existing.AG, counts.AG);
        existing.AP = Math.max(existing.AP, counts.AP);
        existing.AB = Math.max(existing.AB, counts.AB);
        if (!existing.sources.includes(sourceKey)) existing.sources.push(sourceKey);
      }
    }
    for (const entry of merged.values()) {
      entry.total = entry.AG + entry.AP + entry.AB;
    }
    return merged;
  }

  /** Merges every source's data for one home↔NYC combo into a single
   * route view, in roughly the same shape buildRouteData() used to
   * produce for a single source — endpoint/httpStatus/rawResponse are
   * dropped here since those are inherently per-source (shown instead in
   * the technical details section, straight from `sourcesData`). `data`
  * defaults to the current `sourcesData` but can be a previous snapshot,
  * used to diff availability changes since last time below. */
  function mergeCombo(combo, data = sourcesData) {
    const perSource = SOURCE_KEYS.map((sourceKey) => ({
      sourceKey,
      meta: data && data[sourceKey] && data[sourceKey].routesData[combo.id],
    })).filter(({ meta }) => meta);

    const okSources = perSource.filter(({ meta }) => meta.ok);
    const failedSources = perSource.filter(({ meta }) => !meta.ok).map(({ sourceKey }) => sourceKey);

    return {
      homeCode: combo.home.code,
      requestedCode: combo.nyc.code,
      ok: okSources.length > 0,
      failedSources,
      mismatch: okSources.some(({ meta }) => meta.mismatch),
      outboundMap: mergeDateMaps(okSources.map(({ sourceKey, meta }) => ({ sourceKey, map: meta.outboundMap }))),
      inboundMap: mergeDateMaps(okSources.map(({ sourceKey, meta }) => ({ sourceKey, map: meta.inboundMap }))),
    };
  }

  function buildMergedLastGood(data = sourcesData) {
    const fetchedTimestamps = SOURCE_KEYS.map((key) => data[key] && data[key].fetchedAt).filter(Boolean);
    const fetchedAt = fetchedTimestamps.length > 0 ? fetchedTimestamps.sort().at(-1) : null;
    const routesData = {};
    for (const combo of COMBOS) {
      routesData[combo.id] = mergeCombo(combo, data);
    }
    return { fetchedAt, routesData };
  }

  /** Compares a previous merged snapshot against the new one and returns
   * every route/date/direction whose merged total either increased or
   * decreased, including dates that disappeared from the current feed. */
  function computeAvailabilityChanges(prevMerged, newMerged) {
    const changes = new Map();
    for (const combo of COMBOS) {
      const newMeta = newMerged.routesData[combo.id];
      const prevMeta = prevMerged && prevMerged.routesData[combo.id];
      if (!newMeta && !prevMeta) continue;
      for (const direction of ["inbound", "outbound"]) {
        const newMap = newMeta ? (direction === "inbound" ? newMeta.inboundMap : newMeta.outboundMap) : new Map();
        const prevMap = prevMeta ? (direction === "inbound" ? prevMeta.inboundMap : prevMeta.outboundMap) : null;
        const dates = new Set([...newMap.keys(), ...(prevMap ? prevMap.keys() : [])]);
        for (const date of dates) {
          const previousTotal = prevMap && prevMap.has(date) ? prevMap.get(date).total : 0;
          const newTotal = newMap.has(date) ? newMap.get(date).total : 0;
          if (newTotal === previousTotal) continue;
          changes.set(`${combo.id}|${direction}|${date}`, {
            type: newTotal > previousTotal ? "increased" : "decreased",
            previousTotal,
            newTotal,
          });
        }
      }
    }
    return changes;
  }

  function availabilityChange(comboId, direction, dateStr) {
    return availabilityChanges.get(`${comboId}|${direction}|${dateStr}`) || null;
  }

  function isIncreased(comboId, direction, dateStr) {
    return availabilityChange(comboId, direction, dateStr)?.type === "increased";
  }

  function enabledCombos() {
    return COMBOS.filter((combo) => state.nycAirports[combo.nyc.id] && state.homeAirports[combo.home.id]);
  }

  function getActiveMap(comboId) {
    const meta = lastGood && lastGood.routesData[comboId];
    if (!meta) return new Map();
    return state.direction === "inbound" ? meta.inboundMap : meta.outboundMap;
  }

  function passesRowFilters(counts) {
    if (state.cabin === "all") return counts.total >= state.minSeats;
    return (counts[state.cabin] || 0) >= state.minSeats;
  }

  /** Builds one row per (enabled home×NYC combo, date-in-month), applying
   * filters. Delegates to buildTableRowsAllMonths() when the "all months"
   * toggle is on. */
  function buildTableRows() {
    if (state.allMonths) return buildTableRowsAllMonths();

    const rows = [];
    if (!lastGood) return rows;
    const [y, m] = state.month.split("-").map(Number);
    if (!y || !m) return rows;
    const numDays = daysInMonth(y, m);

    for (const combo of enabledCombos()) {
      const meta = lastGood.routesData[combo.id];
      const map = getActiveMap(combo.id);

      for (let d = 1; d <= numDays; d++) {
        const dateStr = `${y}-${pad2(m)}-${pad2(d)}`;
        const counts = map.get(dateStr);
        const change = availabilityChange(combo.id, state.direction, dateStr);

        if (counts) {
          if (!passesRowFilters(counts)) continue;
          rows.push({
            date: dateStr,
            nyc: combo.nyc.code,
            home: combo.home.code,
            direction: state.direction,
            AG: counts.AG,
            AP: counts.AP,
            AB: counts.AB,
            total: counts.total,
            sources: counts.sources.map((key) => SOURCES[key].label).join(", "),
            statusText: meta.mismatch ? "Mismatch: a source returned an unexpected airport code" : "OK",
            isNoResult: false,
            isNew: change?.type === "increased",
            isLost: change?.type === "decreased",
          });
        } else if (state.includeMissing || change?.type === "decreased") {
          rows.push({
            date: dateStr,
            nyc: combo.nyc.code,
            home: combo.home.code,
            direction: state.direction,
            AG: null,
            AP: null,
            AB: null,
            total: null,
            sources: "—",
            statusText: change?.type === "decreased"
              ? `Availability decreased since your last visit (${change.previousTotal} → 0)`
              : meta.ok
              ? "No result returned"
              : `All sources failed for this route (${meta.failedSources.length} of ${SOURCE_KEYS.length})`,
            isNoResult: true,
            isNew: false,
            isLost: change?.type === "decreased",
          });
        }
      }
    }
    return rows;
  }

  /** Same as buildTableRows() but scans every date each enabled route
   * actually has data for, across all fetched months, instead of only the
   * days in `state.month`. There's no natural full date range to iterate
   * (the fetch window varies per source), so "include missing dates" has
   * no meaning here and is simply ignored. */
  function buildTableRowsAllMonths() {
    const rows = [];
    if (!lastGood) return rows;

    for (const combo of enabledCombos()) {
      const meta = lastGood.routesData[combo.id];
      if (!meta || !meta.ok) continue;
      const map = getActiveMap(combo.id);
      const seenDates = new Set();

      for (const [dateStr, counts] of map) {
        seenDates.add(dateStr);
        if (!passesRowFilters(counts)) continue;
        const change = availabilityChange(combo.id, state.direction, dateStr);
        rows.push({
          date: dateStr,
          nyc: combo.nyc.code,
          home: combo.home.code,
          direction: state.direction,
          AG: counts.AG,
          AP: counts.AP,
          AB: counts.AB,
          total: counts.total,
          sources: counts.sources.map((key) => SOURCES[key].label).join(", "),
          statusText: meta.mismatch ? "Mismatch: a source returned an unexpected airport code" : "OK",
          isNoResult: false,
          isNew: change?.type === "increased",
          isLost: change?.type === "decreased",
        });
      }

      for (const [key, change] of availabilityChanges) {
        const [comboId, direction, dateStr] = key.split("|");
        if (comboId !== combo.id || direction !== state.direction || change.type !== "decreased" || seenDates.has(dateStr)) {
          continue;
        }
        rows.push({
          date: dateStr,
          nyc: combo.nyc.code,
          home: combo.home.code,
          direction: state.direction,
          AG: null,
          AP: null,
          AB: null,
          total: null,
          sources: "—",
          statusText: `Availability decreased since your last visit (${change.previousTotal} → 0)`,
          isNoResult: true,
          isNew: false,
          isLost: true,
        });
      }
    }
    return rows;
  }

  function sortRows(rows) {
    const { key, dir } = state.sort;
    const factor = dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av ?? "").localeCompare(String(bv ?? "")) * factor;
      }
      return ((av ?? -1) - (bv ?? -1)) * factor;
    });
  }

  function buildSummary() {
    if (!lastGood) return null;
    const matchingRows = buildTableRows().filter((r) => !r.isNoResult);
    const distinctDates = new Set(matchingRows.map((r) => r.date));
    const economyDates = new Set(matchingRows.filter((r) => r.AG > 0).map((r) => r.date));
    const premiumDates = new Set(matchingRows.filter((r) => r.AP > 0).map((r) => r.date));
    const businessDates = new Set(matchingRows.filter((r) => r.AB > 0).map((r) => r.date));
    const earliestDate = [...distinctDates].sort()[0] || null;
    let latestInbound = null;
    for (const combo of enabledCombos()) {
      const meta = lastGood.routesData[combo.id];
      if (!meta) continue;
      for (const dateStr of meta.inboundMap.keys()) {
        if (!latestInbound || dateStr > latestInbound) latestInbound = dateStr;
      }
    }

    return {
      datesReturned: distinctDates.size,
      economyDates: economyDates.size,
      premiumDates: premiumDates.size,
      businessDates: businessDates.size,
      earliestDate,
      latestInbound,
    };
  }

  function renderSummary() {
    els.summary.replaceChildren();
    const summary = buildSummary();

    if (!summary) {
      const p = document.createElement("p");
      p.className = "summary-empty";
      p.textContent = 'Press "Fetch latest availability" to see a summary.';
      els.summary.appendChild(p);
      return;
    }

    const cards = [
      {
        label: `Dates returned (${state.allMonths ? "all months" : "selected month"})`,
        value: String(summary.datesReturned),
        tone: summary.datesReturned > 0 ? "primary" : "empty",
      },
      { label: "Dates with Economy", value: String(summary.economyDates), tone: summary.economyDates > 0 ? "economy" : "empty" },
      {
        label: "Dates with Premium Economy",
        value: String(summary.premiumDates),
        tone: summary.premiumDates > 0 ? "premium" : "empty",
      },
      { label: "Dates with Business", value: String(summary.businessDates), tone: summary.businessDates > 0 ? "business" : "empty" },
      {
        label: "Earliest matching date",
        value: summary.earliestDate ? formatDateDisplay(summary.earliestDate) : "None found",
        tone: summary.earliestDate ? "date" : "empty",
      },
      {
        label: "Latest inbound date (API)",
        value: summary.latestInbound ? formatDateDisplay(summary.latestInbound) : "Unknown",
        tone: summary.latestInbound ? "date" : "empty",
      },
    ];

    for (const { label, value, tone } of cards) {
      const card = document.createElement("div");
      card.className = `summary-card summary-card--${tone}`;
      const valueEl = document.createElement("p");
      valueEl.className = "summary-card__value";
      valueEl.textContent = value;
      const labelEl = document.createElement("p");
      labelEl.className = "summary-card__label";
      labelEl.textContent = label;
      card.appendChild(valueEl);
      card.appendChild(labelEl);
      els.summary.appendChild(card);
    }
  }

  function summarizeCalendarDay(dateStr) {
    let routeCount = 0;
    let shownTotal = 0;
    let hasIncrease = false;
    let hasDecrease = false;

    for (const combo of enabledCombos()) {
      const meta = lastGood.routesData[combo.id];
      if (!meta || !meta.ok) continue;
      const counts = getActiveMap(combo.id).get(dateStr);
      const change = availabilityChange(combo.id, state.direction, dateStr);
      if (change?.type === "increased") hasIncrease = true;
      if (change?.type === "decreased") hasDecrease = true;
      if (!counts) continue;
      const shown = state.cabin === "all" ? counts.total : counts[state.cabin] || 0;
      if (shown <= 0) continue;
      routeCount += 1;
      shownTotal += shown;
    }

    return { routeCount, shownTotal, hasIncrease, hasDecrease, hasAvailability: routeCount > 0 };
  }

  function renderCalendar() {
    els.calendarHeading.textContent = formatMonthHeading(state.month);
    els.calendar.replaceChildren();

    if (!lastGood) {
      const p = document.createElement("p");
      p.className = "calendar-empty";
      p.textContent = 'Press "Fetch latest availability" to load the calendar.';
      els.calendar.appendChild(p);
      return;
    }

    const [y, m] = state.month.split("-").map(Number);
    if (!y || !m) return;
    const numDays = daysInMonth(y, m);
    const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0

    const grid = document.createElement("div");
    grid.className = "calendar-grid";

    for (const wd of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      const el = document.createElement("div");
      el.className = "calendar-weekday";
      el.textContent = wd;
      grid.appendChild(el);
    }

    for (let i = 0; i < firstWeekday; i++) {
      const blank = document.createElement("div");
      blank.className = "calendar-day calendar-day--blank";
      grid.appendChild(blank);
    }

    for (let d = 1; d <= numDays; d++) {
      const dateStr = `${y}-${pad2(m)}-${pad2(d)}`;
      const dayEl = document.createElement("div");
      dayEl.className = "calendar-day";
      dayEl.tabIndex = 0;
      dayEl.setAttribute("role", "button");
      dayEl.setAttribute("aria-label", `Show details for ${formatDateDisplay(dateStr)}`);
      dayEl.addEventListener("click", () => openDayDetail(dateStr));
      dayEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openDayDetail(dateStr);
      });

      const numEl = document.createElement("div");
      numEl.className = "calendar-day__num";
      numEl.textContent = String(d);
      dayEl.appendChild(numEl);

      const mobileSummary = summarizeCalendarDay(dateStr);
      if (mobileSummary.hasAvailability) {
        dayEl.classList.add("calendar-day--available");
      } else if (mobileSummary.hasDecrease) {
        dayEl.classList.add("calendar-day--lost");
      } else {
        dayEl.classList.add("calendar-day--empty");
      }
      const mobileEl = document.createElement("div");
      mobileEl.className = "calendar-day__mobile-summary";
      if (mobileSummary.routeCount === 0) {
        mobileEl.textContent = mobileSummary.hasDecrease ? "Lost" : "No trips";
      } else {
        mobileEl.textContent = `${mobileSummary.shownTotal}`;
        const countEl = document.createElement("span");
        countEl.textContent = `${mobileSummary.routeCount} route${mobileSummary.routeCount === 1 ? "" : "s"}`;
        mobileEl.appendChild(countEl);
      }
      if (mobileSummary.hasIncrease) {
        mobileEl.classList.add("calendar-day__mobile-summary--new");
        mobileEl.append(" ▲");
      } else if (mobileSummary.hasDecrease) {
        mobileEl.classList.add("calendar-day__mobile-summary--lost");
        mobileEl.append(" ▼");
      }
      dayEl.appendChild(mobileEl);

      for (const nyc of NYC_AIRPORTS) {
        if (!state.nycAirports[nyc.id]) continue;
        const enabledHomes = HOME_AIRPORTS.filter((home) => state.homeAirports[home.id]);
        if (enabledHomes.length === 0) continue;

        const row = document.createElement("div");
        row.className = "calendar-day__airport";

        const codeEl = document.createElement("span");
        codeEl.className = "calendar-day__airport-code";
        codeEl.textContent = nyc.code;
        row.appendChild(codeEl);

        for (const home of enabledHomes) {
          const meta = lastGood.routesData[`${home.id}-${nyc.id}`];
          const chip = document.createElement("span");

          if (!meta || !meta.ok) {
            chip.className = "calendar-badge calendar-badge--error";
            chip.textContent = `${home.code} —`;
            chip.title = `${home.code}: fetch failed`;
            row.appendChild(chip);
            continue;
          }

          const map = state.direction === "inbound" ? meta.inboundMap : meta.outboundMap;
          const counts = map.get(dateStr);
          if (!counts) {
            chip.className = "calendar-badge calendar-badge--empty";
            chip.textContent = `${home.code} —`;
            chip.title = `${home.code}: no result returned`;
            const change = availabilityChange(`${home.id}-${nyc.id}`, state.direction, dateStr);
            if (change?.type === "decreased") {
              chip.classList.add("calendar-badge--lost");
              chip.textContent += " ▼";
              chip.title += ` — decreased since your last visit (${change.previousTotal} → 0)`;
            }
          } else {
            const bestCabin = state.cabin !== "all" ? state.cabin : CABIN_PRIORITY.find((c) => counts[c] > 0) || "AG";
            const shown = state.cabin === "all" ? counts.total : counts[state.cabin] || 0;
            const sourceLabels = counts.sources.map((key) => SOURCES[key].label).join(", ");
            chip.className = `calendar-badge calendar-badge--${bestCabin.toLowerCase()}`;
            chip.textContent = `${home.code} ${shown}`;
            chip.title = `${home.code}: Economy ${counts.AG}, Premium Economy ${counts.AP}, Business ${counts.AB} (source: ${sourceLabels})`;
            const change = availabilityChange(`${home.id}-${nyc.id}`, state.direction, dateStr);
            if (change?.type === "increased") {
              chip.classList.add("calendar-badge--new");
              chip.textContent += " ▲";
              chip.title += ` — increased since your last visit (${change.previousTotal} → ${change.newTotal})`;
            } else if (change?.type === "decreased") {
              chip.classList.add("calendar-badge--lost");
              chip.textContent += " ▼";
              chip.title += ` — decreased since your last visit (${change.previousTotal} → ${change.newTotal})`;
            }
          }
          if (meta.mismatch) {
            chip.textContent += " ⚠";
            chip.title += " — a source returned an unexpected airport code (see technical details)";
          }
          row.appendChild(chip);
        }
        dayEl.appendChild(row);
      }
      grid.appendChild(dayEl);
    }

    els.calendar.appendChild(grid);
  }

  /** Adds one term/value pair to a <dl>, matching the technical-details style. */
  function addDlRow(dl, term, value) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  function buildSasFlightSearchUrl(origin, destination, dateStr) {
    const url = new URL("https://www.sas.se/book/flights/");
    url.searchParams.set("search", `OW_${origin}-${destination}-${dateStr.replaceAll("-", "")}_a1c0i0y0`);
    url.searchParams.set("view", "upsell");
    url.searchParams.set("bookingFlow", "points");
    url.searchParams.set("sortBy", "rec");
    url.searchParams.set("filterBy", "all");
    return url.toString();
  }

  /** Builds the detailed breakdown shown in the day-detail dialog: every
   * enabled NYC↔home route's cabin counts for the CURRENTLY SELECTED
   * direction only (the same one the calendar square itself is showing —
   * switch the "Direction" filter to see the other leg, so the popup never
   * shows data the square doesn't). */
  function renderDayDetail(dateStr) {
    els.dayDetailContent.replaceChildren();

    const h3 = document.createElement("h3");
    h3.textContent = `${formatDateDisplay(dateStr)} (${formatWeekday(dateStr)})`;
    els.dayDetailContent.appendChild(h3);

    const directionLabel =
      state.direction === "inbound" ? "Return: New York → home" : "Outbound: home → New York";
    const p = document.createElement("p");
    p.className = "day-detail-subtitle";
    p.textContent = directionLabel;
    els.dayDetailContent.appendChild(p);

    const routes = enabledCombos();
    if (routes.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No airports are enabled in the filters above.";
      els.dayDetailContent.appendChild(empty);
      return;
    }

    for (const combo of routes) {
      const meta = lastGood.routesData[combo.id];
      const origin = state.direction === "inbound" ? combo.nyc.code : combo.home.code;
      const destination = state.direction === "inbound" ? combo.home.code : combo.nyc.code;

      const block = document.createElement("a");
      block.className = "day-detail-route";
      block.href = buildSasFlightSearchUrl(origin, destination, dateStr);
      block.target = "_blank";
      block.rel = "noreferrer";
      block.title = `Open SAS flight search for ${origin} → ${destination} on ${formatDateDisplay(dateStr)}`;
      const h4 = document.createElement("h4");
      h4.textContent = `${combo.nyc.code} ↔ ${combo.home.code}`;
      block.appendChild(h4);

      const counts = meta && meta.ok ? (state.direction === "inbound" ? meta.inboundMap : meta.outboundMap).get(dateStr) : null;
      const change = availabilityChange(combo.id, state.direction, dateStr);

      if (!meta || !meta.ok) {
        const empty = document.createElement("p");
        empty.className = "day-detail-empty";
        empty.textContent = meta
          ? `All sources failed for this route (${meta.failedSources.length}/${SOURCE_KEYS.length}).`
          : "No data.";
        block.appendChild(empty);
      } else if (!counts) {
        const empty = document.createElement("p");
        empty.className = "day-detail-empty";
        empty.textContent = "No result returned for this date.";
        block.appendChild(empty);
      } else {
        const dl = document.createElement("dl");
        addDlRow(dl, "Economy", String(counts.AG));
        addDlRow(dl, "Premium Economy", String(counts.AP));
        addDlRow(dl, "Business", String(counts.AB));
        addDlRow(dl, "Total", String(counts.total));
        addDlRow(dl, "Reported by", counts.sources.map((key) => SOURCES[key].label).join(", "));
        block.appendChild(dl);

        if (change?.type === "increased") {
          const note = document.createElement("p");
          note.className = "day-detail-new";
          note.textContent = `▲ Availability increased since your last visit (${change.previousTotal} → ${change.newTotal}).`;
          block.appendChild(note);
        } else if (change?.type === "decreased") {
          const note = document.createElement("p");
          note.className = "day-detail-lost";
          note.textContent = `▼ Availability decreased since your last visit (${change.previousTotal} → ${change.newTotal}).`;
          block.appendChild(note);
        }
      }

      if (!counts && change?.type === "decreased") {
        const note = document.createElement("p");
        note.className = "day-detail-lost";
        note.textContent = `▼ Availability disappeared since your last visit (${change.previousTotal} → 0).`;
        block.appendChild(note);
      }

      if (meta && meta.mismatch) {
        const warn = document.createElement("p");
        warn.className = "day-detail-warning";
        warn.textContent = "⚠ A source returned an unexpected airport code for this route — see technical details.";
        block.appendChild(warn);
      }

      els.dayDetailContent.appendChild(block);
    }
  }

  function openDayDetail(dateStr) {
    if (!lastGood) return;
    renderDayDetail(dateStr);
    if (typeof els.dayDetailDialog.showModal === "function") {
      els.dayDetailDialog.showModal();
    } else {
      els.dayDetailDialog.setAttribute("open", "");
    }
  }

  function renderTable() {
    els.tableBody.replaceChildren();
    const rows = sortRows(buildTableRows());
    renderTableMeta(rows);

    if (!lastGood) {
      appendTableMessage('Press "Fetch latest availability" to load data.');
      return;
    }
    if (rows.length === 0) {
      appendTableMessage("No dates match the current filters.");
      return;
    }

    for (const row of rows) {
      const tr = document.createElement("tr");
      if (row.isNoResult) tr.classList.add("row--no-result");
      if (row.isNew) {
        tr.classList.add("row--new");
        tr.title = "Availability increased since your last visit";
      }
      if (row.isLost) {
        tr.classList.add("row--lost");
        tr.title = "Availability decreased since your last visit";
      }
      const values = [
        formatDateDisplay(row.date),
        formatWeekday(row.date),
        row.nyc,
        row.home,
        row.direction === "inbound" ? "Return" : "Outbound",
        row.AG === null ? "—" : String(row.AG),
        row.AP === null ? "—" : String(row.AP),
        row.AB === null ? "—" : String(row.AB),
        row.total === null ? "—" : String(row.total),
        row.sources,
        row.statusText,
      ];
      for (const value of values) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      els.tableBody.appendChild(tr);
    }
  }

  function renderTableMeta(rows) {
    if (!lastGood) {
      els.tableMeta.textContent = "";
      return;
    }
    const availableRows = rows.filter((row) => !row.isNoResult);
    const dates = new Set(availableRows.map((row) => row.date));
    const routes = new Set(availableRows.map((row) => `${row.nyc}-${row.home}`));
    const newCount = availableRows.filter((row) => row.isNew).length;
    const lostCount = rows.filter((row) => row.isLost).length;
    const scope = state.allMonths ? "all fetched months" : formatMonthHeading(state.month);
    els.tableMeta.textContent =
      `${availableRows.length} matching rows · ${dates.size} dates · ${routes.size} routes · ${scope}` +
      (newCount || lostCount ? ` · ${newCount} new / ${lostCount} decreased` : "");
  }

  function renderMonthlyActivity() {
    els.monthlyActivity.replaceChildren();
    const activity = monthlyActivityFor(state.month);
    const scope = formatMonthHeading(state.month);
    const cards = [
      { label: "Seats added", value: activity.added, tone: activity.added > 0 ? "added" : "empty" },
      { label: "Seats disappeared/booked", value: activity.lost, tone: activity.lost > 0 ? "lost" : "empty" },
      { label: "Net movement", value: activity.added - activity.lost, tone: activity.added - activity.lost >= 0 ? "added" : "lost" },
    ];

    const heading = document.createElement("p");
    heading.className = "monthly-activity__scope";
    heading.textContent = scope;
    els.monthlyActivity.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "monthly-activity__grid";
    for (const card of cards) {
      const el = document.createElement("div");
      el.className = `activity-card activity-card--${card.tone}`;
      const value = document.createElement("p");
      value.className = "activity-card__value";
      value.textContent = String(card.value);
      const label = document.createElement("p");
      label.className = "activity-card__label";
      label.textContent = card.label;
      el.appendChild(value);
      el.appendChild(label);
      grid.appendChild(el);
    }
    els.monthlyActivity.appendChild(grid);
  }

  function appendTableMessage(message) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 11;
    td.className = "table-empty";
    td.textContent = message;
    tr.appendChild(td);
    els.tableBody.appendChild(tr);
  }

  function summarizeAvailabilityMap(map) {
    let totalSeats = 0;
    let businessDates = 0;
    let latestDate = null;
    for (const [date, counts] of map) {
      totalSeats += counts.total;
      if (counts.AB > 0) businessDates += 1;
      if (!latestDate || date > latestDate) latestDate = date;
    }
    return { dates: map.size, totalSeats, businessDates, latestDate };
  }

  function sourceStatus(meta) {
    if (!meta) return { tone: "missing", label: "No data" };
    if (!meta.ok) return { tone: "error", label: "Failed" };
    if (meta.mismatch) return { tone: "warn", label: "Check" };
    return { tone: "ok", label: "OK" };
  }

  function renderTechnicalDetails() {
    els.technical.replaceChildren();
    if (!sourcesData) {
      const p = document.createElement("p");
      p.className = "technical-empty";
      p.textContent = 'Press "Fetch latest availability" to load technical details.';
      els.technical.appendChild(p);
      return;
    }

    for (const combo of enabledCombos()) {
      const details = document.createElement("details");
      details.className = "tech-details";
      const summary = document.createElement("summary");
      const sourceStats = SOURCE_KEYS.map((sourceKey) => sourcesData[sourceKey] && sourcesData[sourceKey].routesData[combo.id]);
      const okCount = sourceStats.filter((meta) => meta && meta.ok).length;
      const merged = lastGood && lastGood.routesData[combo.id];
      const inbound = merged ? summarizeAvailabilityMap(merged.inboundMap) : { dates: 0 };
      const outbound = merged ? summarizeAvailabilityMap(merged.outboundMap) : { dates: 0 };
      summary.textContent = `${combo.nyc.code} ↔ ${combo.home.code} · ${okCount}/${SOURCE_KEYS.length} sources OK · ${inbound.dates} return / ${outbound.dates} outbound dates`;
      details.appendChild(summary);

      const grid = document.createElement("div");
      grid.className = "tech-source-grid";

      for (const sourceKey of SOURCE_KEYS) {
        const src = sourcesData[sourceKey];
        const meta = src && src.routesData[combo.id];
        const status = sourceStatus(meta);

        const block = document.createElement("div");
        block.className = `tech-source-card tech-source-card--${status.tone}`;

        const header = document.createElement("div");
        header.className = "tech-source-card__header";
        const h4 = document.createElement("h4");
        h4.textContent = SOURCES[sourceKey].label;
        header.appendChild(h4);
        const pill = document.createElement("span");
        pill.className = `tech-status tech-status--${status.tone}`;
        pill.textContent = status.label;
        header.appendChild(pill);
        block.appendChild(header);

        if (!meta) {
          const p = document.createElement("p");
          p.className = "tech-source-card__empty";
          p.textContent = "No data (this source failed to load and no cached data was available).";
          block.appendChild(p);
          grid.appendChild(block);
          continue;
        }

        const sourceInbound = summarizeAvailabilityMap(meta.inboundMap);
        const sourceOutbound = summarizeAvailabilityMap(meta.outboundMap);
        const dl = document.createElement("dl");
        addDlRow(dl, "Return dates", `${sourceInbound.dates} (${sourceInbound.totalSeats} seats)`);
        addDlRow(dl, "Outbound dates", `${sourceOutbound.dates} (${sourceOutbound.totalSeats} seats)`);
        addDlRow(dl, "Business dates", String(sourceInbound.businessDates + sourceOutbound.businessDates));
        addDlRow(dl, "Latest date", sourceInbound.latestDate || sourceOutbound.latestDate || "—");
        addDlRow(dl, "Updated", src.fetchedAt ? formatTimestamp(src.fetchedAt) : "—");
        addDlRow(dl, "HTTP", meta.httpStatus !== null ? String(meta.httpStatus) : "—");
        block.appendChild(dl);

        if (meta.endpoint) {
          const link = document.createElement("a");
          link.className = "tech-endpoint-link";
          link.href = meta.endpoint;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = "Open source endpoint";
          block.appendChild(link);
        }

        const raw = document.createElement("details");
        raw.className = "tech-raw-details";
        const rawSummary = document.createElement("summary");
        rawSummary.textContent = "Raw response";
        raw.appendChild(rawSummary);
        const pre = document.createElement("pre");
        pre.className = "tech-raw";
        pre.textContent = meta.ok ? JSON.stringify(meta.rawResponse, null, 2) : meta.error || "No data available for this route.";
        raw.appendChild(pre);
        block.appendChild(raw);

        grid.appendChild(block);
      }

      details.appendChild(grid);

      els.technical.appendChild(details);
    }
  }

  function updateLastFetchedDisplay() {
    if (lastGood && lastGood.fetchedAt) {
      els.lastFetched.textContent = formatTimestamp(lastGood.fetchedAt);
      els.lastFetched.setAttribute("datetime", lastGood.fetchedAt);
    } else {
      els.lastFetched.textContent = "Not yet fetched";
      els.lastFetched.removeAttribute("datetime");
    }
  }

  function updateSortIndicators() {
    els.table.querySelectorAll("th[data-sort]").forEach((th) => {
      th.removeAttribute("data-sort-dir");
      if (th.dataset.sort === state.sort.key) {
        th.setAttribute("data-sort-dir", state.sort.dir);
      }
    });
  }

  function renderAll() {
    updateLastFetchedDisplay();
    renderSummary();
    renderCalendar();
    renderTable();
    renderTechnicalDetails();
    renderMonthlyActivity();
    updateSortIndicators();
  }

  /** Fetches one source's published JSON file, falling back to its own
   * cached copy on failure. Never throws — failures are reported back via
   * the returned `error` field so one source failing can't stop the others
   * from loading. Also returns whatever was cached BEFORE this fetch (i.e.
   * from the visitor's last visit), used to detect newly-increased
   * availability — captured first, since a successful fetch immediately
   * overwrites the cache. */
  async function fetchOneSource(sourceKey) {
    const previousCached = loadPersistedPayload(sourceKey);
    const previousNormalized = previousCached ? normalizePayload(previousCached) : null;
    try {
      // Cache-bust so this actually re-reads the published file instead of
      // an HTTP-cached copy. This only re-fetches a static file — it never
      // triggers any backend job or calls SAS/awardhacks.se/roamsnap.com/
      // awardfares.com/seats.aero directly.
      const url = `${SOURCES[sourceKey].url}?t=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      const payload = await response.json();
      persistPayload(sourceKey, payload);
      return { normalized: normalizePayload(payload), previousNormalized, error: null };
    } catch (err) {
      return { normalized: previousNormalized, previousNormalized, error: err.message };
    }
  }

  async function handleFetchClick() {
    els.fetchBtn.disabled = true;
    els.fetchBtn.setAttribute("aria-busy", "true");
    els.fetchBtnSpinner.hidden = false;
    els.fetchBtnLabel.textContent = "Fetching availability…";
    setStatus("Fetching availability…");

    const results = await Promise.all(SOURCE_KEYS.map((key) => fetchOneSource(key)));
    sourcesData = {};
    const previousSourcesData = {};
    const errors = {};
    SOURCE_KEYS.forEach((key, i) => {
      sourcesData[key] = results[i].normalized;
      previousSourcesData[key] = results[i].previousNormalized;
      if (results[i].error) errors[key] = results[i].error;
    });
    lastGood = buildMergedLastGood();

    // Only highlight increases if this browser actually had SOME previous
    // data cached (i.e. not the very first visit ever) — otherwise every
    // date would look "new" on first load, which isn't useful.
    const hadAnyPreviousData = SOURCE_KEYS.some((key) => previousSourcesData[key] !== null);
    availabilityChanges = hadAnyPreviousData
      ? computeAvailabilityChanges(buildMergedLastGood(previousSourcesData), lastGood)
      : new Map();
    if (hadAnyPreviousData) recordMonthlyActivity(availabilityChanges);

    const failedKeys = Object.keys(errors);
    const loadedKeys = SOURCE_KEYS.filter((key) => sourcesData[key] !== null);
    if (failedKeys.length === 0) {
      setStatus("Loaded latest data from all sources.", "ok");
    } else if (loadedKeys.length > 0) {
      const labels = failedKeys.map((key) => SOURCES[key].label).join(", ");
      setStatus(
        `Loaded ${loadedKeys.length}/${SOURCE_KEYS.length} sources — ${labels} couldn't be updated (showing cached data for them where available).`,
        "warn"
      );
    } else {
      setStatus("All sources failed to load, and no cached data is available.", "error");
    }

    els.fetchBtn.disabled = false;
    els.fetchBtn.removeAttribute("aria-busy");
    els.fetchBtnSpinner.hidden = true;
    els.fetchBtnLabel.textContent = "Fetch latest availability";
    renderAll();
  }

  function handleFilterChange() {
    state.direction = els.directionSelect.value === "outbound" ? "outbound" : "inbound";
    state.month = /^\d{4}-\d{2}$/.test(els.monthInput.value) ? els.monthInput.value : state.month;
    state.nycAirports.jfk = els.nycJfk.checked;
    state.nycAirports.ewr = els.nycEwr.checked;
    state.homeAirports.arn = els.homeArn.checked;
    state.homeAirports.osl = els.homeOsl.checked;
    state.homeAirports.cph = els.homeCph.checked;
    state.cabin = ["all", "AG", "AP", "AB"].includes(els.cabinSelect.value) ? els.cabinSelect.value : "all";
    const parsedMinSeats = Number.parseInt(els.minSeatsInput.value, 10);
    state.minSeats = Number.isFinite(parsedMinSeats) && parsedMinSeats >= 0 ? parsedMinSeats : 0;
    state.allMonths = els.allMonthsToggle.checked;
    // "Include missing dates" has no meaning once the table spans every
    // fetched month instead of one bounded month — grey it out rather than
    // silently ignoring a checked box.
    els.includeMissingToggle.disabled = state.allMonths;
    state.includeMissing = !state.allMonths && els.includeMissingToggle.checked;
    renderAll();
    syncStateToUrl();
  }

  /** Moves the Month filter forward/back by `delta` months and re-applies
   * every filter (reusing handleFilterChange so this stays the single
   * source of truth for turning DOM inputs into state). */
  function shiftMonth(delta) {
    const [y, m] = state.month.split("-").map(Number);
    if (!y || !m) return;
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    els.monthInput.value = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}`;
    handleFilterChange();
  }

  /** Jumps the Month filter to whichever fetched month contains the
   * earliest currently-matching date, searching across ALL fetched months
   * (not just the one currently selected) and switching off "all months"
   * afterwards so the table lands on that one month. */
  function jumpToEarliestMatch() {
    const rows = buildTableRowsAllMonths().filter((r) => !r.isNoResult);
    if (rows.length === 0) {
      setStatus("No matching dates found across the fetched data.", "warn");
      return;
    }
    const earliest = rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date);
    els.allMonthsToggle.checked = false;
    els.monthInput.value = earliest.slice(0, 7);
    handleFilterChange();
    setStatus(`Jumped to ${formatDateDisplay(earliest)}, the earliest matching date.`, "ok");
  }

  function jumpToLatestMatch() {
    const rows = buildTableRowsAllMonths().filter((r) => !r.isNoResult);
    if (rows.length === 0) {
      setStatus("No matching dates found across the fetched data.", "warn");
      return;
    }
    const latest = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date);
    els.allMonthsToggle.checked = false;
    els.monthInput.value = latest.slice(0, 7);
    handleFilterChange();
    setStatus(`Jumped to ${formatDateDisplay(latest)}, the latest matching date.`, "ok");
  }

  const SORT_KEYS = ["date", "dow", "nyc", "home", "direction", "AG", "AP", "AB", "total"];

  /** Reads filter/sort state out of the URL's query string (if present) and
   * applies it to the DOM inputs — called once on load, BEFORE the first
   * handleFilterChange(), so that call's normal "read inputs into state"
   * pass picks these up. This makes the current view shareable/bookmarkable
   * and lets a reload restore exactly what was being looked at. */
  function applyUrlParamsToInputs() {
    const params = new URLSearchParams(location.search);
    if (params.has("dir")) els.directionSelect.value = params.get("dir") === "outbound" ? "outbound" : "inbound";
    if (params.has("month") && /^\d{4}-\d{2}$/.test(params.get("month"))) els.monthInput.value = params.get("month");
    if (params.has("nyc")) {
      const enabled = new Set(params.get("nyc").split(",").filter(Boolean));
      els.nycJfk.checked = enabled.has("jfk");
      els.nycEwr.checked = enabled.has("ewr");
    }
    if (params.has("home")) {
      const enabled = new Set(params.get("home").split(",").filter(Boolean));
      els.homeArn.checked = enabled.has("arn");
      els.homeOsl.checked = enabled.has("osl");
      els.homeCph.checked = enabled.has("cph");
    }
    if (params.has("cabin") && ["all", "AG", "AP", "AB"].includes(params.get("cabin"))) {
      els.cabinSelect.value = params.get("cabin");
    }
    if (params.has("minSeats")) els.minSeatsInput.value = params.get("minSeats");
    if (params.has("includeMissing")) els.includeMissingToggle.checked = params.get("includeMissing") === "1";
    if (params.has("allMonths")) els.allMonthsToggle.checked = params.get("allMonths") === "1";
    if (params.has("sortKey") && SORT_KEYS.includes(params.get("sortKey"))) state.sort.key = params.get("sortKey");
    if (params.has("sortDir")) state.sort.dir = params.get("sortDir") === "desc" ? "desc" : "asc";
  }

  /** Serializes the current filter/sort state into the URL's query string
   * (via replaceState, not pushState, so toggling a checkbox repeatedly
   * doesn't spam the browser's back-button history) — only non-default
   * values are included, to keep the URL short and readable. */
  function syncStateToUrl() {
    const params = new URLSearchParams();
    if (state.direction !== "inbound") params.set("dir", state.direction);
    params.set("month", state.month);
    const nycKeys = NYC_AIRPORTS.filter((a) => state.nycAirports[a.id]).map((a) => a.id);
    if (nycKeys.length !== NYC_AIRPORTS.length) params.set("nyc", nycKeys.join(","));
    const homeKeys = HOME_AIRPORTS.filter((a) => state.homeAirports[a.id]).map((a) => a.id);
    if (homeKeys.length !== HOME_AIRPORTS.length) params.set("home", homeKeys.join(","));
    if (state.cabin !== "all") params.set("cabin", state.cabin);
    if (state.minSeats !== 1) params.set("minSeats", String(state.minSeats));
    if (state.includeMissing) params.set("includeMissing", "1");
    if (state.allMonths) params.set("allMonths", "1");
    if (state.sort.key !== "date") params.set("sortKey", state.sort.key);
    if (state.sort.dir !== "asc") params.set("sortDir", state.sort.dir);
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
  }

  function handleRefreshPageClick() {
    syncStateToUrl();
    const url = new URL(location.href);
    url.searchParams.set("reload", String(Date.now()));
    location.assign(url.toString());
  }

  function isUnlocked() {
    try {
      return localStorage.getItem(AUTH_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function rememberUnlocked() {
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, "1");
    } catch {
      // If storage is unavailable, this login still unlocks the current page load.
    }
  }

  function unlockDashboard() {
    document.body.classList.remove("auth-locked");
    if (els.loginDialog.open) els.loginDialog.close();
    applyUrlParamsToInputs();
    handleFilterChange();
    handleFetchClick();
  }

  function showLoginDialog() {
    document.body.classList.add("auth-locked");
    if (typeof els.loginDialog.showModal === "function") {
      els.loginDialog.showModal();
    } else {
      els.loginDialog.setAttribute("open", "");
    }
    els.loginPassword.focus();
  }

  function handleLoginSubmit(e) {
    e.preventDefault();
    if (els.loginPassword.value === AUTH_PASSWORD) {
      rememberUnlocked();
      els.loginPassword.value = "";
      els.loginError.hidden = true;
      unlockDashboard();
      return;
    }
    els.loginError.hidden = false;
    els.loginPassword.select();
  }

  [
    els.directionSelect,
    els.monthInput,
    els.nycJfk,
    els.nycEwr,
    els.homeArn,
    els.homeOsl,
    els.homeCph,
    els.cabinSelect,
    els.minSeatsInput,
    els.includeMissingToggle,
    els.allMonthsToggle,
  ].forEach((el) => el.addEventListener("change", handleFilterChange));

  // Generic "All"/"None" shortcuts for the checkbox fieldsets above, so
  // isolating e.g. a single home airport doesn't take one click per box.
  const CHECKBOX_GROUPS = {
    nyc: [els.nycJfk, els.nycEwr],
    home: [els.homeArn, els.homeOsl, els.homeCph],
  };
  document.querySelectorAll(".select-shortcut").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = CHECKBOX_GROUPS[btn.dataset.group];
      if (!group) return;
      const checked = btn.dataset.action === "all";
      group.forEach((checkbox) => {
        checkbox.checked = checked;
      });
      handleFilterChange();
    });
  });

  els.prevMonthBtn.addEventListener("click", () => shiftMonth(-1));
  els.nextMonthBtn.addEventListener("click", () => shiftMonth(1));
  els.jumpEarliestBtn.addEventListener("click", jumpToEarliestMatch);
  els.jumpLatestBtn.addEventListener("click", jumpToLatestMatch);

  els.table.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = { key, dir: "asc" };
      }
      renderTable();
      updateSortIndicators();
      syncStateToUrl();
    });
  });

  els.fetchBtn.addEventListener("click", handleFetchClick);
  els.refreshPageBtn.addEventListener("click", handleRefreshPageClick);
  els.loginForm.addEventListener("submit", handleLoginSubmit);
  els.loginDialog.addEventListener("cancel", (e) => e.preventDefault());

  els.dayDetailClose.addEventListener("click", () => els.dayDetailDialog.close());
  // Native <dialog> has no built-in "click outside to close" — treat a
  // click landing on the dialog element itself (i.e. outside its padded
  // content box) as a backdrop click. Escape-to-close is already native.
  els.dayDetailDialog.addEventListener("click", (e) => {
    if (e.target !== els.dayDetailDialog) return;
    const rect = els.dayDetailDialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) els.dayDetailDialog.close();
  });

  if (isUnlocked()) {
    unlockDashboard();
  } else {
    renderAll();
    showLoginDialog();
  }
})();
