/**
 * NYC → Nordics Award Finder dashboard frontend.
 *
 * Covers every combination of NYC airport (JFK/EWR) and home airport
 * (ARN/OSL/CPH), since a return seat to any of the three is useful.
 *
 * This script only ever reads static, already-published JSON files (one per
 * data source — see SOURCES below) using relative URLs — automatically on
 * page load, and again whenever "Refresh availability" is pressed. It
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
  const CALENDAR_LOCALE = "sv-SE";
  const calendarLocale = new Intl.Locale(CALENDAR_LOCALE);
  const calendarWeekStart = (
    calendarLocale.getWeekInfo?.() ?? calendarLocale.weekInfo ?? { firstDay: 1 }
  ).firstDay % 7;
  // Cosmetic static-site gate, not server-side access control.
  const AUTH_PASSWORD_SALT = "acdeb67dcfc1ae0ed0afbe2dbb000106";
  const AUTH_PASSWORD_HASH = "8716c1c327e7a16b737d8a48eed7b3f9e81f8a1f9d9f6fc4a9a8f9878c5351a0";
  const AUTH_STORAGE_KEY = "awards:dashboardUnlocked";
  const AUTH_LOCK_KEY = "awards:loginLockedUntil";
  const AUTH_LOCK_MS = 30 * 60 * 1000;
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

  // Trip suggestions can be narrowed to a short, varied shortlist; otherwise
  // every combination is paged rather than dumped on the page.
  const TRIP_SUGGESTIONS_BEST = 5;
  const TRIP_SUGGESTIONS_PAGE_SIZE = 5;

  const TABLE_PAGE_SIZE = 10;

  // Beyond a handful of seats per cabin SAS never returns anything, so the
  // stepper stops there instead of offering values that only ever match none.
  const MAX_MIN_SEATS = 9;

  const els = {
    refreshBtn: document.getElementById("refresh-btn"),
    refreshBtnLabel: document.getElementById("refresh-btn-label"),
    refreshBtnSpinner: document.getElementById("refresh-btn-spinner"),
    lastFetched: document.getElementById("last-fetched-value"),
    status: document.getElementById("status-message"),
    filtersPanel: document.getElementById("filters-panel"),
    filtersSummary: document.getElementById("filters-summary"),
    filtersSticky: document.getElementById("filters-sticky"),
    filtersStickySummary: document.getElementById("filters-sticky-summary"),
    directionSegmented: document.getElementById("direction-segmented"),
    monthRail: document.getElementById("month-rail"),
    nycJfk: document.getElementById("nyc-jfk"),
    nycEwr: document.getElementById("nyc-ewr"),
    homeArn: document.getElementById("home-arn"),
    homeOsl: document.getElementById("home-osl"),
    homeCph: document.getElementById("home-cph"),
    cabinChips: document.getElementById("cabin-chips"),
    minSeatsValue: document.getElementById("min-seats-value"),
    minSeatsUnit: document.getElementById("min-seats-unit"),
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
    tableScroll: document.getElementById("table-scroll"),
    tablePager: document.getElementById("table-pager"),
    technical: document.getElementById("technical-details"),
    monthlyActivity: document.getElementById("monthly-activity"),
    tripSuggestions: document.getElementById("trip-suggestions"),
    tripSuggestionsMeta: document.getElementById("trip-suggestions-meta"),
    tripSuggestionsFilters: document.getElementById("trip-suggestions-filters"),
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
    // Trip-suggestion-only filters, layered on top of the airport filters above.
    tripBestOnly: false,
    tripBusinessOnly: false,
    tripRoundTrip: true,
    tripOpenJaw: true,
    tripAirports: { arn: true, osl: true, cph: true, jfk: true, ewr: true },
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
  let tripSuggestionsPage = 0;
  let tablePage = 0;
  // The rail scrolls the selected month into view, but jumping on the very
  // first render would look like the page moved on its own.
  let monthRailRendered = false;

  const CHECKBOX_GROUPS = {
    nyc: [els.nycJfk, els.nycEwr],
    home: [els.homeArn, els.homeOsl, els.homeCph],
  };

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

  // Constructing an Intl formatter is expensive, and these are called per
  // table row and per trip suggestion — build each one once, and memoize
  // per date since the same dates recur thousands of times.
  const dateDisplayFormat = new Intl.DateTimeFormat(CALENDAR_LOCALE, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const weekdayFormat = new Intl.DateTimeFormat(CALENDAR_LOCALE, { timeZone: "UTC", weekday: "short" });
  const dateDisplayCache = new Map();
  const weekdayCache = new Map();

  function utcDateFrom(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  /** Formats a "YYYY-MM-DD" string with no timezone-driven date shift. */
  function formatDateDisplay(dateStr) {
    if (!isIsoDateOnly(dateStr)) return String(dateStr);
    let formatted = dateDisplayCache.get(dateStr);
    if (formatted === undefined) {
      formatted = dateDisplayFormat.format(utcDateFrom(dateStr));
      dateDisplayCache.set(dateStr, formatted);
    }
    return formatted;
  }

  function formatWeekday(dateStr) {
    if (!isIsoDateOnly(dateStr)) return "—";
    let formatted = weekdayCache.get(dateStr);
    if (formatted === undefined) {
      formatted = weekdayFormat.format(utcDateFrom(dateStr));
      weekdayCache.set(dateStr, formatted);
    }
    return formatted;
  }

  function formatCount(value) {
    return new Intl.NumberFormat(CALENDAR_LOCALE).format(value);
  }

  function formatMonthHeading(monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    if (!y || !m) return "Calendar";
    const label = new Intl.DateTimeFormat(CALENDAR_LOCALE, {
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
      image: !returnedCode || returnedCode !== requestedCode.toUpperCase() ? null : entry?.image,
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
      p.textContent = 'Press "Refresh availability" to see a summary.';
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

  // Fit complete airport rows rather than clipping seat counts or widening cells.
  const calendarRowObserver = new ResizeObserver(() => {
    const rows = [...els.calendar.querySelectorAll(".calendar-day__airport")];
    rows.forEach((row) => { row.style.fontSize = ""; });
    const sizes = rows.map((row) => {
      if (!row.clientWidth || row.scrollWidth <= row.clientWidth) return null;
      const fontSize = Number.parseFloat(getComputedStyle(row).fontSize);
      const borderWidth = [...row.children].reduce((total, child) => {
        const style = getComputedStyle(child);
        return total + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
      }, 0);
      // Gaps and padding use em units and scale with the text; borders don't.
      return fontSize * Math.max(0, row.clientWidth - borderWidth - 1) / (row.scrollWidth - borderWidth);
    });
    rows.forEach((row, index) => {
      if (sizes[index] !== null) row.style.fontSize = `${sizes[index]}px`;
    });
  });

  function renderCalendar() {
    calendarRowObserver.disconnect();
    els.calendarHeading.textContent = formatMonthHeading(state.month);
    els.calendar.replaceChildren();

    if (!lastGood) {
      const p = document.createElement("p");
      p.className = "calendar-empty";
      p.textContent = 'Press "Refresh availability" to load the calendar.';
      els.calendar.appendChild(p);
      return;
    }

    const [y, m] = state.month.split("-").map(Number);
    if (!y || !m) return;
    const numDays = daysInMonth(y, m);
    const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() - calendarWeekStart + 7) % 7;

    const grid = document.createElement("div");
    grid.className = "calendar-grid";

    const weekdayLabel = new Intl.DateTimeFormat(CALENDAR_LOCALE, { weekday: "narrow", timeZone: "UTC" });
    const weekdayName = new Intl.DateTimeFormat(CALENDAR_LOCALE, { weekday: "long", timeZone: "UTC" });
    for (let column = 0; column < 7; column++) {
      // January 7, 2024 was a Sunday; use UTC just like the date cells.
      const date = new Date(Date.UTC(2024, 0, 7 + calendarWeekStart + column));
      const el = document.createElement("div");
      el.className = "calendar-weekday";
      el.textContent = weekdayLabel.format(date).toLocaleUpperCase(CALENDAR_LOCALE);
      el.setAttribute("aria-label", weekdayName.format(date));
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
    calendarRowObserver.observe(grid);
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

  function buildSasSearchUrl(searchToken) {
    const url = new URL("https://www.sas.se/book/flights/");
    url.searchParams.set("search", searchToken);
    url.searchParams.set("view", "upsell");
    url.searchParams.set("bookingFlow", "points");
    url.searchParams.set("sortBy", "rec");
    url.searchParams.set("filterBy", "all");
    return url.toString();
  }

  function compactDate(dateStr) {
    return dateStr.replaceAll("-", "");
  }

  function buildSasFlightSearchUrl(origin, destination, dateStr) {
    return buildSasSearchUrl(`OW_${origin}-${destination}-${compactDate(dateStr)}_a1c0i0y0`);
  }

  /** "Tur och retur": SAS derives the return leg from the same airport
   * pair, so a round trip is the outbound route plus both dates. */
  function buildSasRoundTripSearchUrl(origin, destination, outboundDate, returnDate) {
    return buildSasSearchUrl(
      `RT_${origin}-${destination}-${compactDate(outboundDate)}-${compactDate(returnDate)}_a1c0i0y0`
    );
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
    els.tablePager.replaceChildren();
    const rows = sortRows(buildTableRows());
    renderTableMeta(rows);

    if (!lastGood) {
      appendTableMessage('Press "Refresh availability" to load data.');
      return;
    }
    if (rows.length === 0) {
      appendTableMessage("No dates match the current filters.");
      return;
    }

    // A filter can shrink the result set under the page being viewed.
    const pageCount = Math.ceil(rows.length / TABLE_PAGE_SIZE);
    tablePage = Math.min(Math.max(tablePage, 0), pageCount - 1);
    const start = tablePage * TABLE_PAGE_SIZE;
    const visible = rows.slice(start, start + TABLE_PAGE_SIZE);

    for (const row of visible) {
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

    if (pageCount > 1) {
      els.tablePager.appendChild(renderTablePager(start, visible.length, rows.length, pageCount));
    }
  }

  function goToTablePage(page) {
    tablePage = page;
    renderTable();
    els.tableScroll.scrollIntoView({ block: "start" });
  }

  function renderTablePager(start, shown, total, pageCount) {
    const nav = document.createElement("nav");
    nav.className = "table-pager";
    nav.setAttribute("aria-label", "Available date pages");

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "month-nav-btn";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "Previous page of dates");
    prev.disabled = tablePage === 0;
    prev.addEventListener("click", () => goToTablePage(tablePage - 1));
    nav.appendChild(prev);

    const status = document.createElement("p");
    status.className = "table-pager__status";
    status.setAttribute("role", "status");
    status.textContent = `${formatCount(start + 1)}–${formatCount(start + shown)} of ${formatCount(total)}`;
    nav.appendChild(status);

    const next = document.createElement("button");
    next.type = "button";
    next.className = "month-nav-btn";
    next.textContent = "›";
    next.setAttribute("aria-label", "Next page of dates");
    next.disabled = tablePage >= pageCount - 1;
    next.addEventListener("click", () => goToTablePage(tablePage + 1));
    nav.appendChild(next);

    const pages = document.createElement("p");
    pages.className = "table-pager__pages";
    pages.textContent = `Page ${formatCount(tablePage + 1)} of ${formatCount(pageCount)}`;
    nav.appendChild(pages);

    return nav;
  }

  function renderTableMeta(rows) {
    els.tableMeta.replaceChildren();
    if (!lastGood) return;

    const availableRows = rows.filter((row) => !row.isNoResult);
    const dates = new Set(availableRows.map((row) => row.date));
    const routes = new Set(availableRows.map((row) => `${row.nyc}-${row.home}`));
    const newCount = availableRows.filter((row) => row.isNew).length;
    const lostCount = rows.filter((row) => row.isLost).length;

    const scope = document.createElement("span");
    scope.className = "table-meta__scope";
    scope.textContent = state.allMonths ? "All fetched months" : formatMonthHeading(state.month);
    els.tableMeta.appendChild(scope);

    if (availableRows.length === 0) {
      const empty = document.createElement("span");
      empty.className = "table-meta__empty";
      empty.textContent = "No matching dates";
      els.tableMeta.appendChild(empty);
      return;
    }

    const stats = [
      { value: dates.size, label: dates.size === 1 ? "date" : "dates" },
      { value: routes.size, label: routes.size === 1 ? "route" : "routes" },
      { value: availableRows.length, label: availableRows.length === 1 ? "row" : "rows" },
    ];
    for (const stat of stats) {
      const el = document.createElement("span");
      el.className = "table-stat";
      const value = document.createElement("span");
      value.className = "table-stat__value";
      value.textContent = formatCount(stat.value);
      const label = document.createElement("span");
      label.className = "table-stat__label";
      label.textContent = stat.label;
      el.append(value, label);
      els.tableMeta.appendChild(el);
    }

    const deltas = [
      { count: newCount, tone: "new", symbol: "↑", label: "new" },
      { count: lostCount, tone: "lost", symbol: "↓", label: "gone" },
    ];
    for (const delta of deltas) {
      if (delta.count === 0) continue;
      const el = document.createElement("span");
      el.className = `table-delta table-delta--${delta.tone}`;
      el.title = delta.tone === "new"
        ? "Availability increased since your last visit"
        : "Availability decreased since your last visit";
      el.textContent = `${delta.symbol} ${formatCount(delta.count)} ${delta.label}`;
      els.tableMeta.appendChild(el);
    }
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

  /** Today as a plain UTC calendar date, matching how every other date in
   * this app is handled — past availability can't be booked, so it never
   * belongs in a trip suggestion. */
  function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Combos that pass both the page-wide airport filters and the
   * trip-suggestion airport chips. */
  function tripSuggestionCombos() {
    return enabledCombos().filter((combo) => state.tripAirports[combo.home.id] && state.tripAirports[combo.nyc.id]);
  }

  /** Feeds the currently enabled routes and filters into the pure
   * trip-suggestion engine (assets/trip-suggestions.js). Scoped to the
   * selected month by DEPARTURE date only, so a trip that leaves late in
   * the month can still return in the next one. */
  function buildTripSuggestionList() {
    const engine = globalThis.TripSuggestions;
    if (!engine || !lastGood) return null;
    const routes = tripSuggestionCombos()
      .map((combo) => {
        const meta = lastGood.routesData[combo.id];
        if (!meta || !meta.ok) return null;
        return {
          homeCode: combo.home.code,
          nycCode: combo.nyc.code,
          outboundMap: meta.outboundMap,
          inboundMap: meta.inboundMap,
        };
      })
      .filter(Boolean);
    if (routes.length === 0) return { best: [], trips: [], total: 0, routes: 0 };
    const result = engine.buildTripSuggestions({
      routes,
      minSeats: Math.max(1, state.minSeats),
      // The Business chip is the more specific control, so it wins over the
      // page-wide Cabin filter while it is on.
      cabin: state.tripBusinessOnly ? "AB" : state.cabin,
      earliestDate: todayIsoDate(),
      departureMonth: state.month,
      allowRoundTrip: state.tripRoundTrip,
      allowOpenJaw: state.tripOpenJaw,
      bestLimit: TRIP_SUGGESTIONS_BEST,
    });
    return { ...result, routes: routes.length };
  }

  /** One leg of a suggested trip, rendered as a direct link into the SAS
   * points search — the same interaction the day-detail dialog already
   * uses. `booking.href` is a single return search when the trip really is
   * a round trip, so it opens as one booking instead of two one-ways. */
  function renderTripLeg(leg, label, booking) {
    const el = document.createElement("a");
    el.className = "trip-leg";
    el.href = booking.href;
    el.target = "_blank";
    el.rel = "noreferrer";
    el.title =
      `${leg.from} → ${leg.to} on ${formatDateDisplay(leg.date)} — ` +
      `Economy ${leg.counts.AG}, Premium Economy ${leg.counts.AP}, Business ${leg.counts.AB}` +
      (booking.roundTrip ? " — opens as one return trip on SAS" : "");

    const direction = document.createElement("p");
    direction.className = "trip-leg__direction";
    direction.textContent = label;
    el.appendChild(direction);

    const route = document.createElement("p");
    route.className = "trip-leg__route";
    const arrow = document.createElement("span");
    arrow.className = "trip-leg__arrow";
    arrow.textContent = "→";
    route.append(leg.from, arrow, leg.to);
    el.appendChild(route);

    const meta = document.createElement("p");
    meta.className = "trip-leg__meta";
    const when = document.createElement("time");
    when.dateTime = leg.date;
    when.textContent = `${formatWeekday(leg.date)} ${formatDateDisplay(leg.date)}`;
    meta.appendChild(when);
    const cabin = document.createElement("span");
    cabin.className = `trip-leg__cabin trip-leg__cabin--${leg.cabin.code.toLowerCase()}`;
    cabin.textContent = leg.cabin.label;
    meta.appendChild(cabin);
    el.appendChild(meta);

    return el;
  }

  function renderTripSuggestion(trip) {
    const article = document.createElement("article");
    const roundTrip = !trip.openJaw.any;
    // A round trip is one booking, so the whole row highlights together;
    // an open jaw is two, so its legs stay individually hoverable.
    article.className = `trip trip--${trip.cabinKey}${roundTrip ? " trip--round-trip" : ""}`;

    const returnHref = roundTrip
      ? buildSasRoundTripSearchUrl(trip.outbound.from, trip.outbound.to, trip.outbound.date, trip.inbound.date)
      : null;
    const bookingFor = (leg) => ({
      roundTrip,
      href: returnHref || buildSasFlightSearchUrl(leg.from, leg.to, leg.date),
    });

    const legs = document.createElement("div");
    legs.className = "trip__legs";
    legs.appendChild(renderTripLeg(trip.outbound, "Out", bookingFor(trip.outbound)));
    legs.appendChild(renderTripLeg(trip.inbound, "Back", bookingFor(trip.inbound)));
    article.appendChild(legs);

    const meta = document.createElement("div");
    meta.className = "trip__meta";

    const nights = document.createElement("p");
    nights.className = "trip__nights";
    const nightsValue = document.createElement("strong");
    nightsValue.textContent = String(trip.nights);
    nights.appendChild(nightsValue);
    nights.append(` night${trip.nights === 1 ? "" : "s"}`);
    meta.appendChild(nights);

    // Each leg already states its own cabin, so only a split cabin is worth
    // repeating at trip level — anything else would just be noise.
    if (trip.cabinKey === "mixed") {
      const cabin = document.createElement("p");
      cabin.className = "trip__cabin";
      cabin.textContent = trip.cabinLabel;
      cabin.title = `${trip.outbound.cabin.label} out, ${trip.inbound.cabin.label} back.`;
      meta.appendChild(cabin);
    }

    if (trip.openJaw.any) {
      const jaw = document.createElement("p");
      jaw.className = "trip__open-jaw";
      jaw.textContent = "Open jaw";
      jaw.title = trip.openJaw.description;
      meta.appendChild(jaw);
    }

    article.appendChild(meta);
    return article;
  }

  function renderTripSuggestionsEmpty(message) {
    const p = document.createElement("p");
    p.className = "trip-suggestions__empty";
    p.textContent = message;
    els.tripSuggestions.appendChild(p);
  }

  function addTripFilterButton(parent, id, label, pressed, title, onToggle) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trip-filter";
    button.dataset.tripFilter = id;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(pressed));
    button.title = title;
    button.addEventListener("click", () => {
      onToggle();
      tripSuggestionsPage = 0;
      renderTripSuggestions();
      // Re-rendering replaces the button that was just clicked.
      els.tripSuggestionsFilters.querySelector(`[data-trip-filter="${id}"]`)?.focus();
    });
    parent.appendChild(button);
    return button;
  }

  /** Only airports left on by the page-wide filters get a chip, so the two
   * levels of filtering can never contradict each other. */
  function addTripAirportGroup(label, airports, enabled) {
    const available = airports.filter((airport) => enabled[airport.id]);
    if (available.length === 0) return;
    const group = document.createElement("div");
    group.className = "trip-filter-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const airport of available) {
      addTripFilterButton(
        group,
        airport.id,
        airport.code,
        state.tripAirports[airport.id],
        `${label}: ${airport.code}`,
        () => {
          state.tripAirports[airport.id] = !state.tripAirports[airport.id];
        }
      );
    }
    els.tripSuggestionsFilters.appendChild(group);
  }

  function renderTripFilters() {
    els.tripSuggestionsFilters.replaceChildren();
    const best = addTripFilterButton(
      els.tripSuggestionsFilters,
      "best",
      `Best ${TRIP_SUGGESTIONS_BEST}`,
      state.tripBestOnly,
      "Show only the strongest suggestions — at most one per departure and return date",
      () => {
        state.tripBestOnly = !state.tripBestOnly;
      }
    );
    best.classList.add("trip-filter--primary");

    addTripFilterButton(
      els.tripSuggestionsFilters,
      "business",
      "Business",
      state.tripBusinessOnly,
      "Only trips with Business availability on both legs",
      () => {
        state.tripBusinessOnly = !state.tripBusinessOnly;
      }
    );

    const tripType = document.createElement("div");
    tripType.className = "trip-filter-group";
    tripType.setAttribute("role", "group");
    tripType.setAttribute("aria-label", "Trip type");
    addTripFilterButton(
      tripType,
      "roundtrip",
      "Round trip",
      state.tripRoundTrip,
      "Return from the same New York airport to the same home airport — one booking",
      () => {
        state.tripRoundTrip = !state.tripRoundTrip;
      }
    );
    addTripFilterButton(
      tripType,
      "openjaw",
      "Open jaw",
      state.tripOpenJaw,
      "Fly home to a different airport, or back from the other New York airport — two bookings",
      () => {
        state.tripOpenJaw = !state.tripOpenJaw;
      }
    );
    els.tripSuggestionsFilters.appendChild(tripType);

    addTripAirportGroup("Home airport", HOME_AIRPORTS, state.homeAirports);
    addTripAirportGroup("New York airport", NYC_AIRPORTS, state.nycAirports);
  }

  function renderTripSuggestions() {
    renderTripFilters();
    els.tripSuggestions.replaceChildren();
    els.tripSuggestionsMeta.textContent = "";

    const result = buildTripSuggestionList();
    if (!result) {
      renderTripSuggestionsEmpty('Press "Refresh availability" to build trip suggestions.');
      return;
    }
    if (result.routes === 0) {
      renderTripSuggestionsEmpty("Select at least one home and one New York airport above to see trip suggestions.");
      return;
    }
    if (!state.tripRoundTrip && !state.tripOpenJaw) {
      renderTripSuggestionsEmpty("Select a trip type above — round trip, open jaw, or both.");
      return;
    }
    if (result.total === 0) {
      renderTripSuggestionsEmpty(
        `No 5–10 night trips depart in ${formatMonthHeading(state.month)} with the current filters. ` +
          "Try another month, fewer minimum seats, more airports, or turning off Business."
      );
      return;
    }

    const effectiveCabin = state.tripBusinessOnly ? "AB" : state.cabin;
    const cabinFilterLabel =
      effectiveCabin === "all"
        ? "any cabin"
        : effectiveCabin === "AB"
        ? "Business only"
        : effectiveCabin === "AP"
        ? "Premium Economy only"
        : "Economy only";
    const tripTypeLabel = state.tripRoundTrip && state.tripOpenJaw ? null : state.tripRoundTrip ? "round trips" : "open jaws";
    const seats = Math.max(1, state.minSeats);
    const total = result.total;
    const scope = state.tripBestOnly
      ? `Best ${formatCount(result.best.length)} of ${formatCount(total)} possible trips`
      : `${formatCount(total)} possible trip${total === 1 ? "" : "s"}`;
    els.tripSuggestionsMeta.textContent =
      `${scope} departing in ${formatMonthHeading(state.month)} · ` +
      `5–10 nights · ${seats}+ seat${seats === 1 ? "" : "s"} · ${cabinFilterLabel}` +
      (tripTypeLabel ? ` · ${tripTypeLabel} only` : "");

    const pageCount = Math.max(1, Math.ceil(total / TRIP_SUGGESTIONS_PAGE_SIZE));
    if (tripSuggestionsPage >= pageCount) tripSuggestionsPage = 0;
    const start = tripSuggestionsPage * TRIP_SUGGESTIONS_PAGE_SIZE;
    const visible = state.tripBestOnly
      ? result.best
      : result.trips.slice(start, start + TRIP_SUGGESTIONS_PAGE_SIZE);

    const list = document.createElement("div");
    list.className = "trip-list";
    for (const trip of visible) list.appendChild(renderTripSuggestion(trip));
    els.tripSuggestions.appendChild(list);

    if (state.tripBestOnly) return;

    const footer = document.createElement("div");
    footer.className = "trip-suggestions__footer";
    footer.appendChild(renderTripPager(start, visible.length, total, pageCount));
    els.tripSuggestions.appendChild(footer);
  }

  function goToTripSuggestionsPage(page) {
    tripSuggestionsPage = page;
    renderTripSuggestions();
    els.tripSuggestions.parentElement.scrollIntoView({ block: "start" });
  }

  function renderTripPager(start, shown, total, pageCount) {
    const nav = document.createElement("nav");
    nav.className = "trip-pager";
    nav.setAttribute("aria-label", "Trip suggestion pages");

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "month-nav-btn";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "Previous page of trips");
    prev.disabled = tripSuggestionsPage === 0;
    prev.addEventListener("click", () => goToTripSuggestionsPage(tripSuggestionsPage - 1));
    nav.appendChild(prev);

    const status = document.createElement("p");
    status.className = "trip-pager__status";
    status.setAttribute("role", "status");
    status.textContent = `${formatCount(start + 1)}–${formatCount(start + shown)} of ${formatCount(total)}`;
    nav.appendChild(status);

    const next = document.createElement("button");
    next.type = "button";
    next.className = "month-nav-btn";
    next.textContent = "›";
    next.setAttribute("aria-label", "Next page of trips");
    next.disabled = tripSuggestionsPage >= pageCount - 1;
    next.addEventListener("click", () => goToTripSuggestionsPage(tripSuggestionsPage + 1));
    nav.appendChild(next);

    const pages = document.createElement("p");
    pages.className = "trip-pager__pages";
    pages.textContent = `Page ${formatCount(tripSuggestionsPage + 1)} of ${formatCount(pageCount)}`;
    nav.appendChild(pages);

    return nav;
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
      p.textContent = 'Press "Refresh availability" to load technical details.';
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
      els.lastFetched.textContent = "—";
      els.lastFetched.removeAttribute("datetime");
    }
  }

  /** Describes the active filters for the collapsed filter panel and the
   * sticky bar, so the summary line stays useful when the controls
   * themselves are off screen. */
  function renderFiltersSummary() {
    const codes = (airports, enabled) => airports.filter((a) => enabled[a.id]).map((a) => a.code);
    const nyc = codes(NYC_AIRPORTS, state.nycAirports);
    const home = codes(HOME_AIRPORTS, state.homeAirports);
    const cabin =
      state.cabin === "all" ? "All cabins" : state.cabin === "AB" ? "Business" : state.cabin === "AP" ? "Premium" : "Economy";
    const text = [
      formatMonthHeading(state.month),
      state.direction === "inbound" ? "Return" : "Outbound",
      `${nyc.join("/") || "none"} ↔ ${home.join("/") || "none"}`,
      cabin,
    ].join(" · ");
    els.filtersSummary.textContent = text;
    els.filtersStickySummary.textContent = text;
  }

  /** Pushes `state` back into the custom controls (which, unlike native
   * inputs, hold no value of their own). */
  function renderFilterControls() {
    els.directionSegmented.dataset.active = state.direction;
    for (const option of els.directionSegmented.querySelectorAll("[data-direction]")) {
      const selected = option.dataset.direction === state.direction;
      option.setAttribute("aria-checked", String(selected));
      option.tabIndex = selected ? 0 : -1;
    }

    for (const chip of els.cabinChips.querySelectorAll("[data-cabin]")) {
      const selected = chip.dataset.cabin === state.cabin;
      chip.setAttribute("aria-checked", String(selected));
      chip.tabIndex = selected ? 0 : -1;
    }

    els.minSeatsValue.textContent = formatCount(state.minSeats);
    els.minSeatsUnit.textContent = state.minSeats === 1 ? "seat" : "seats";
    for (const btn of document.querySelectorAll("[data-seats-step]")) {
      const next = state.minSeats + Number(btn.dataset.seatsStep);
      btn.disabled = next < 0 || next > MAX_MIN_SEATS;
    }

    for (const btn of document.querySelectorAll(".chip--all")) {
      btn.setAttribute("aria-pressed", String(isWholeGroupSelected(btn.dataset.group)));
    }

    renderMonthRail();
  }

  function isWholeGroupSelected(group) {
    return CHECKBOX_GROUPS[group] ? CHECKBOX_GROUPS[group].every((box) => box.checked) : false;
  }

  /** The months the rail offers: every month the fetched data covers, with
   * any gaps filled so the strip reads as a continuous timeline, plus the
   * selected month (which may sit outside the fetched window). */
  function monthRailMonths(matchesByMonth) {
    const months = new Set([state.month, ...matchesByMonth.keys()]);
    if (lastGood) {
      for (const combo of COMBOS) {
        for (const dateStr of getActiveMap(combo.id).keys()) months.add(dateStr.slice(0, 7));
      }
    }
    const sorted = [...months].sort();
    const filled = [];
    let [y, m] = sorted[0].split("-").map(Number);
    const last = sorted[sorted.length - 1];
    for (let guard = 0; guard < 120; guard++) {
      const month = `${y}-${pad2(m)}`;
      filled.push(month);
      if (month >= last) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return filled;
  }

  /** A month picker that doubles as a heat strip: each month carries a dot
   * whose strength reflects how many dates in it match the current filters,
   * so the choice is informed instead of trial and error. */
  function renderMonthRail() {
    const datesByMonth = new Map();
    for (const row of buildTableRowsAllMonths()) {
      if (row.isNoResult) continue;
      const month = row.date.slice(0, 7);
      if (!datesByMonth.has(month)) datesByMonth.set(month, new Set());
      datesByMonth.get(month).add(row.date);
    }

    const months = monthRailMonths(datesByMonth);
    const busiest = Math.max(1, ...months.map((month) => datesByMonth.get(month)?.size ?? 0));

    els.monthRail.replaceChildren();
    for (const month of months) {
      const matches = datesByMonth.get(month)?.size ?? 0;
      const selected = month === state.month;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "month-chip";
      chip.dataset.month = month;
      chip.dataset.matches = String(matches);
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", String(selected));
      chip.tabIndex = selected ? 0 : -1;
      chip.setAttribute(
        "aria-label",
        `${formatMonthHeading(month)} — ${formatCount(matches)} matching ${matches === 1 ? "date" : "dates"}`
      );
      if (matches > 0) chip.style.setProperty("--dot-strength", String(0.35 + 0.65 * (matches / busiest)));

      const label = document.createElement("span");
      label.className = "month-chip__label";
      label.textContent = formatMonthRailLabel(month);
      const dot = document.createElement("span");
      dot.className = "month-chip__dot";
      chip.append(label, dot);
      els.monthRail.appendChild(chip);
    }

    const active = els.monthRail.querySelector('[aria-checked="true"]');
    if (active) {
      els.monthRail.scrollTo({
        left: active.offsetLeft - els.monthRail.clientWidth / 2 + active.clientWidth / 2,
        behavior: monthRailRendered ? "smooth" : "auto",
      });
    }
    monthRailRendered = true;
  }

  function formatMonthRailLabel(monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    const label = new Intl.DateTimeFormat(CALENDAR_LOCALE, { timeZone: "UTC", month: "short" }).format(
      new Date(Date.UTC(y, m - 1, 1))
    );
    return `${label.charAt(0).toUpperCase()}${label.slice(1).replace(".", "")} ${pad2(y % 100)}`;
  }

  function updateSortIndicators() {
    els.table.querySelectorAll("th[data-sort]").forEach((th) => {
      th.removeAttribute("data-sort-dir");
      if (th.dataset.sort === state.sort.key) {
        th.setAttribute("data-sort-dir", state.sort.dir);
      }
    });
  }

  function renderDestinationImage() {
    const image = document.getElementById("destination-image");
    const airports = ["ewr", "jfk"].filter((airport) => state.nycAirports[airport]);
    let src = null;
    for (const airport of airports) {
      for (const home of HOME_AIRPORTS) {
        const candidate = sourcesData?.sas?.routesData[`${home.id}-${airport}`]?.image;
        if (typeof candidate !== "string") continue;
        try {
          const url = new URL(candidate);
          if (url.protocol === "https:" && url.hostname === "components.flysas.com") {
            src = url.href;
            break;
          }
        } catch { /* Missing or malformed image metadata should not affect the dashboard. */ }
      }
      if (src) break;
    }
    if (!src) {
      image.hidden = true;
      image.removeAttribute("src");
    } else if (image.getAttribute("src") !== src) {
      image.hidden = true;
      image.onload = () => { image.hidden = false; };
      image.onerror = () => { image.hidden = true; };
      image.src = src;
    }
  }

  function renderAll() {
    renderDestinationImage();
    updateLastFetchedDisplay();
    renderFilterControls();
    renderFiltersSummary();
    renderSummary();
    renderCalendar();
    tablePage = 0; // a filter change makes the old page number meaningless
    renderTable();
    renderTechnicalDetails();
    renderMonthlyActivity();
    tripSuggestionsPage = 0;
    renderTripSuggestions();
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
    els.refreshBtn.disabled = true;
    els.refreshBtn.setAttribute("aria-busy", "true");
    els.refreshBtnSpinner.hidden = false;
    els.refreshBtnLabel.textContent = "Fetching availability…";
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

    els.refreshBtn.disabled = false;
    els.refreshBtn.removeAttribute("aria-busy");
    els.refreshBtnSpinner.hidden = true;
    els.refreshBtnLabel.textContent = "Refresh availability";
    renderAll();
  }

  /** Re-reads the checkbox-backed filters (the custom controls write to
   * `state` directly when clicked) and re-renders everything. Stays the
   * single funnel every filter change goes through. */
  function handleFilterChange() {
    state.nycAirports.jfk = els.nycJfk.checked;
    state.nycAirports.ewr = els.nycEwr.checked;
    state.homeAirports.arn = els.homeArn.checked;
    state.homeAirports.osl = els.homeOsl.checked;
    state.homeAirports.cph = els.homeCph.checked;
    state.allMonths = els.allMonthsToggle.checked;
    // "Include missing dates" has no meaning once the table spans every
    // fetched month instead of one bounded month — grey it out rather than
    // silently ignoring a checked box.
    els.includeMissingToggle.disabled = state.allMonths;
    state.includeMissing = !state.allMonths && els.includeMissingToggle.checked;
    renderAll();
    syncStateToUrl();
  }

  /** Moves the Month filter forward/back by `delta` months. */
  function shiftMonth(delta) {
    const [y, m] = state.month.split("-").map(Number);
    if (!y || !m) return;
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.month = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}`;
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
    state.month = earliest.slice(0, 7);
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
    state.month = latest.slice(0, 7);
    handleFilterChange();
    setStatus(`Jumped to ${formatDateDisplay(latest)}, the latest matching date.`, "ok");
  }

  const SORT_KEYS = ["date", "dow", "nyc", "home", "direction", "AG", "AP", "AB", "total"];

  /** Reads filter/sort state out of the URL's query string (if present) and
   * applies it — called once on load, BEFORE the first handleFilterChange()
   * and control render, so both pick these up. This makes the current view
   * shareable/bookmarkable and lets a reload restore exactly what was being
   * looked at. */
  function applyUrlParamsToInputs() {
    const params = new URLSearchParams(location.search);
    if (params.has("dir")) state.direction = params.get("dir") === "outbound" ? "outbound" : "inbound";
    if (params.has("month") && /^\d{4}-\d{2}$/.test(params.get("month"))) state.month = params.get("month");
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
      state.cabin = params.get("cabin");
    }
    if (params.has("minSeats")) {
      const parsed = Number.parseInt(params.get("minSeats"), 10);
      if (Number.isFinite(parsed) && parsed >= 0) state.minSeats = Math.min(parsed, MAX_MIN_SEATS);
    }
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

  /** The one header action: a full reload, which re-reads app.js/styles.css
   * and then re-fetches every source from unlockDashboard(). */
  function handleRefreshClick() {
    els.refreshBtn.disabled = true;
    els.refreshBtn.setAttribute("aria-busy", "true");
    els.refreshBtnSpinner.hidden = false;
    els.refreshBtnLabel.textContent = "Refreshing…";
    syncStateToUrl();
    const url = new URL(location.href);
    url.searchParams.set("reload", String(Date.now()));
    location.assign(url.toString());
  }

  function isUnlocked() {
    if (loginLockedUntil() > Date.now()) return false;
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
    updateLoginLock();
    if (!els.loginPassword.disabled) els.loginPassword.focus();
  }

  async function verifyPassword(password) {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const salt = Uint8Array.from(AUTH_PASSWORD_SALT.match(/../g), (byte) => Number.parseInt(byte, 16));
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, key, 256
    );
    const hash = Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hash === AUTH_PASSWORD_HASH;
  }

  let failedLoginAttempts = 0;
  let lockedUntil = 0;
  let lockTimer;

  function loginLockedUntil() {
    try {
      const stored = Number(localStorage.getItem(AUTH_LOCK_KEY));
      if (Number.isFinite(stored)) lockedUntil = Math.max(lockedUntil, stored);
    } catch { /* Retain the in-memory lock if storage is unavailable. */ }
    return lockedUntil;
  }

  function updateLoginLock() {
    clearTimeout(lockTimer);
    const remaining = loginLockedUntil() - Date.now();
    const locked = remaining > 0;
    els.loginPassword.disabled = locked;
    els.loginForm.querySelector('button[type="submit"]').disabled = locked;
    if (locked) {
      els.loginError.hidden = true;
      els.loginError.textContent = "";
      lockTimer = setTimeout(updateLoginLock, Math.min(remaining, AUTH_LOCK_MS));
    } else if (lockedUntil) {
      lockedUntil = 0;
      failedLoginAttempts = 0;
      try { localStorage.removeItem(AUTH_LOCK_KEY); } catch { /* Optional storage. */ }
    }
    return locked;
  }

  window.addEventListener("storage", (event) => {
    if (event.key === AUTH_LOCK_KEY && els.loginDialog.open) updateLoginLock();
  });

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const submit = els.loginForm.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    if (updateLoginLock()) return;
    submit.disabled = true;
    els.loginForm.setAttribute("aria-busy", "true");
    els.loginError.hidden = true;
    try {
      const valid = await verifyPassword(els.loginPassword.value);
      if (loginLockedUntil() > Date.now()) return;
      if (valid) {
        failedLoginAttempts = 0;
        rememberUnlocked();
        els.loginPassword.value = "";
        unlockDashboard();
        return;
      }
      failedLoginAttempts += 1;
      if (failedLoginAttempts >= 2) {
        lockedUntil = Date.now() + AUTH_LOCK_MS;
        try {
          localStorage.setItem(AUTH_LOCK_KEY, String(lockedUntil));
          localStorage.removeItem(AUTH_STORAGE_KEY);
        } catch { /* The current page remains locked if storage is unavailable. */ }
        els.loginPassword.value = "";
      } else {
        els.loginError.textContent = "Wrong password. 1 attempt remaining.";
        els.loginError.hidden = false;
        els.loginPassword.select();
      }
    } catch {
      els.loginError.textContent = "Password verification is unavailable. Open this page over HTTPS in a current browser.";
      els.loginError.hidden = false;
    } finally {
      updateLoginLock();
      els.loginForm.removeAttribute("aria-busy");
    }
  }

  [
    els.nycJfk,
    els.nycEwr,
    els.homeArn,
    els.homeOsl,
    els.homeCph,
    els.includeMissingToggle,
    els.allMonthsToggle,
  ].forEach((el) => el.addEventListener("change", handleFilterChange));

  els.directionSegmented.addEventListener("click", (e) => {
    const option = e.target.closest("[data-direction]");
    if (!option || option.dataset.direction === state.direction) return;
    state.direction = option.dataset.direction;
    handleFilterChange();
  });

  els.cabinChips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cabin]");
    if (!chip || chip.dataset.cabin === state.cabin) return;
    state.cabin = chip.dataset.cabin;
    handleFilterChange();
  });

  els.monthRail.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-month]");
    if (!chip || chip.dataset.month === state.month) return;
    state.month = chip.dataset.month;
    handleFilterChange();
  });

  // Arrow keys move between options within a radiogroup, as expected of the
  // role — the rendered controls are buttons, so this isn't free.
  for (const group of [els.directionSegmented, els.cabinChips, els.monthRail]) {
    group.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (step === 0) return;
      const options = [...group.querySelectorAll('[role="radio"]')];
      const current = options.findIndex((o) => o.getAttribute("aria-checked") === "true");
      const next = options[Math.min(Math.max(current + step, 0), options.length - 1)];
      if (!next || next === options[current]) return;
      e.preventDefault();
      next.click();
      group.querySelector('[aria-checked="true"]')?.focus();
    });
  }

  document.querySelectorAll("[data-seats-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = state.minSeats + Number(btn.dataset.seatsStep);
      if (next < 0 || next > MAX_MIN_SEATS) return;
      state.minSeats = next;
      handleFilterChange();
    });
  });

  // One "All" chip per airport group: selects the whole group, or clears it
  // when everything is already selected.
  document.querySelectorAll(".chip--all").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = CHECKBOX_GROUPS[btn.dataset.group];
      if (!group) return;
      const checked = !isWholeGroupSelected(btn.dataset.group);
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

  // The filter panel is a disclosure only on narrow screens; keep it forced
  // open elsewhere so it can never end up collapsed with its summary hidden.
  const compactFilters = window.matchMedia("(max-width: 40rem)");
  const syncFiltersPanel = () => {
    els.filtersPanel.open = !compactFilters.matches;
  };
  syncFiltersPanel();
  compactFilters.addEventListener("change", syncFiltersPanel);

  // Once the panel itself scrolls away, a compact bar keeps the active
  // filters visible and one tap away while scanning the data below.
  const stickyObserver = new IntersectionObserver(
    ([entry]) => {
      const show = !entry.isIntersecting && !document.body.classList.contains("auth-locked");
      els.filtersSticky.hidden = !show;
      // Let the element lay out before animating in, so it slides rather than appears.
      requestAnimationFrame(() => {
        els.filtersSticky.dataset.visible = String(show);
      });
    },
    { rootMargin: "-8px 0px 0px 0px" }
  );
  stickyObserver.observe(els.filtersPanel);

  els.filtersSticky.addEventListener("click", () => {
    els.filtersPanel.open = true;
    els.filtersPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.table.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = { key, dir: "asc" };
      }
      tablePage = 0;
      renderTable();
      updateSortIndicators();
      syncStateToUrl();
    });
  });

  els.refreshBtn.addEventListener("click", handleRefreshClick);
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
