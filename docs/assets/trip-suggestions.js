/**
 * Trip-suggestion engine for the NYC ↔ Nordics award finder.
 *
 * Pure, deterministic logic only — it never touches the DOM, never fetches
 * anything, and never formats anything for display. It takes the SAME
 * merged route maps the calendar/table already render from (see
 * mergeCombo() in app.js) and pairs an outbound leg (Nordics → New York)
 * with an inbound leg (New York → Nordics) into complete trips.
 *
 * Open jaws are first-class: ARN/CPH/OSL are treated as one origin region
 * and JFK/EWR as one destination region, so the departure and return
 * airports don't have to match on either side.
 *
 * Dates are plain "YYYY-MM-DD" calendar strings and are only ever compared
 * or shifted through Date.UTC, so trip lengths can't drift across month,
 * year or DST boundaries.
 *
 * This file is loaded as a plain <script> in the browser (it assigns to
 * globalThis) and imported for its side effect by the Node test suite, so
 * it must stay free of both DOM globals and import/export syntax.
 */
(function (root) {
  "use strict";

  const DAY_MS = 86400000;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ISO_MONTH = /^\d{4}-\d{2}$/;

  /** Cabin codes as the API reports them, best first. */
  const CABINS = {
    AB: { code: "AB", key: "business", label: "Business", rank: 0 },
    AP: { code: "AP", key: "premium", label: "Premium", rank: 1 },
    AG: { code: "AG", key: "economy", label: "Economy", rank: 2 },
  };
  const CABIN_ORDER = ["AB", "AP", "AG"];

  const DEFAULTS = {
    minNights: 5,
    maxNights: 10,
    bestLimit: 4,
    // Several return dates usually work for the same outbound date; keeping
    // a couple of the strongest per date stops the shortlist collapsing into
    // near-identical itineraries.
    maxPerDate: 2,
  };

  /** Parses a date-only string, rejecting non-existent calendar dates
   * (e.g. "2027-02-30") instead of silently rolling them over. */
  function toUtcMs(dateStr) {
    if (typeof dateStr !== "string" || !ISO_DATE.test(dateStr)) return NaN;
    const [y, m, d] = dateStr.split("-").map(Number);
    const ms = Date.UTC(y, m - 1, d);
    return new Date(ms).toISOString().slice(0, 10) === dateStr ? ms : NaN;
  }

  /** Whole calendar nights between two date-only strings. */
  function nightsBetween(fromDate, toDate) {
    const from = toUtcMs(fromDate);
    const to = toUtcMs(toDate);
    if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
    return Math.round((to - from) / DAY_MS);
  }

  function addDays(dateStr, days) {
    const ms = toUtcMs(dateStr);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
  }

  /** Best cabin on one date that actually has enough seats, honouring an
   * explicit cabin filter. Returns null when the date is unbookable. */
  function pickCabin(counts, minSeats, cabinFilter) {
    if (!counts) return null;
    const codes = CABINS[cabinFilter] ? [cabinFilter] : CABIN_ORDER;
    for (const code of codes) {
      const seats = Number(counts[code]) || 0;
      if (seats >= minSeats) return { cabin: CABINS[code], seats };
    }
    return null;
  }

  function collectLegs(map, from, to, options) {
    const legs = [];
    if (!map || typeof map.entries !== "function") return legs;
    for (const [date, counts] of map) {
      if (Number.isNaN(toUtcMs(date))) continue;
      if (options.earliestDate && date < options.earliestDate) continue;
      if (options.month && !date.startsWith(options.month)) continue;
      const picked = pickCabin(counts, options.minSeats, options.cabin);
      if (!picked) continue;
      legs.push({
        from,
        to,
        date,
        cabin: picked.cabin,
        seats: picked.seats,
        counts: { AG: Number(counts.AG) || 0, AP: Number(counts.AP) || 0, AB: Number(counts.AB) || 0 },
      });
    }
    return legs;
  }

  function describeCabins(outboundCabin, inboundCabin) {
    if (outboundCabin.code === inboundCabin.code) {
      return { key: outboundCabin.key, label: outboundCabin.label };
    }
    return { key: "mixed", label: "Mixed cabin" };
  }

  function describeOpenJaw(outbound, inbound) {
    const nordic = outbound.from !== inbound.to;
    const nyc = outbound.to !== inbound.from;
    if (!nordic && !nyc) return { nordic: false, nyc: false, any: false, description: null };
    let description;
    if (nordic && nyc) {
      description = `Open jaw at both ends — out of ${outbound.from} into ${outbound.to}, back from ${inbound.from} into ${inbound.to}.`;
    } else if (nordic) {
      description = `Open jaw — departs ${outbound.from}, returns to ${inbound.to}.`;
    } else {
      description = `Open jaw — arrives ${outbound.to}, departs ${inbound.from}.`;
    }
    return { nordic, nyc, any: true, description };
  }

  /** Higher is better, but deliberately capped: one extra seat matters,
   * ten of them shouldn't outrank a better airport combination. */
  function seatScore(outbound, inbound) {
    return Math.min(3, Math.min(outbound.seats, inbound.seats));
  }

  /**
   * Ranking, strictly in this order:
   *   1. cabin quality (Business both ways → mixed → Economy both ways)
   *   2. overall itinerary quality (seats actually available)
   *   3. simplicity of the airport combination (round trip before open jaw)
   *   4. purely deterministic tiebreakers, so the same data always yields
   *      the same list in the same order.
   * Trip duration is a hard filter applied before this, not a score.
   */
  function compareTrips(a, b) {
    return (
      a.cabinRank - b.cabinRank ||
      b.seatScore - a.seatScore ||
      a.openJawCount - b.openJawCount ||
      (a.outbound.date < b.outbound.date ? -1 : a.outbound.date > b.outbound.date ? 1 : 0) ||
      a.nights - b.nights ||
      a.id.localeCompare(b.id)
    );
  }

  /**
   * Builds the ranked shortlist of bookable trips.
   *
   * @param {object} options
   * @param {Array<{homeCode: string, nycCode: string, outboundMap: Map, inboundMap: Map}>} options.routes
   *   Merged availability per Nordic↔NYC route. `outboundMap` is home → NY,
   *   `inboundMap` is NY → home, both keyed by "YYYY-MM-DD".
   * @param {number} [options.minSeats=1] Seats required on each leg.
   * @param {string} [options.cabin="all"] "all" | "AG" | "AP" | "AB".
   * @param {number} [options.minNights=5]
   * @param {number} [options.maxNights=10]
   * @param {string|null} [options.earliestDate] Ignore legs before this date.
   * @param {string|null} [options.departureMonth] "YYYY-MM". Restricts the
   *   OUTBOUND leg only, so a trip may still return in the following month.
   * @param {boolean} [options.allowRoundTrip=true] Keep trips that return
   *   from the same New York airport to the same home airport.
   * @param {boolean} [options.allowOpenJaw=true] Keep trips where either end
   *   uses a different airport.
   * @param {number} [options.bestLimit=4] Size of the deduplicated shortlist.
   * @returns {{best: Array, trips: Array, total: number}} `trips` is every
   *   valid combination of the allowed airports across every matching date,
   *   in ranked order; `best` is a short, varied pick from the same ranking.
   */
  function buildTripSuggestions(options) {
    const opts = options || {};
    const routes = Array.isArray(opts.routes) ? opts.routes : [];
    const minSeats = Math.max(1, Number(opts.minSeats) || 1);
    const cabin = CABINS[opts.cabin] ? opts.cabin : "all";
    const minNights = Number.isFinite(opts.minNights) ? opts.minNights : DEFAULTS.minNights;
    const maxNights = Number.isFinite(opts.maxNights) ? opts.maxNights : DEFAULTS.maxNights;
    const bestLimit = Number.isFinite(opts.bestLimit) ? opts.bestLimit : DEFAULTS.bestLimit;
    const maxPerDate = Number.isFinite(opts.maxPerDate) ? opts.maxPerDate : DEFAULTS.maxPerDate;
    const earliestDate =
      typeof opts.earliestDate === "string" && ISO_DATE.test(opts.earliestDate) ? opts.earliestDate : null;
    const departureMonth =
      typeof opts.departureMonth === "string" && ISO_MONTH.test(opts.departureMonth) ? opts.departureMonth : null;
    const allowRoundTrip = opts.allowRoundTrip !== false;
    const allowOpenJaw = opts.allowOpenJaw !== false;
    const legOptions = { minSeats, cabin, earliestDate };
    const outboundOptions = departureMonth ? { ...legOptions, month: departureMonth } : legOptions;

    const outboundLegs = [];
    const inboundByDate = new Map();
    for (const route of routes) {
      if (!route || typeof route.homeCode !== "string" || typeof route.nycCode !== "string") continue;
      outboundLegs.push(...collectLegs(route.outboundMap, route.homeCode, route.nycCode, outboundOptions));
      for (const leg of collectLegs(route.inboundMap, route.nycCode, route.homeCode, legOptions)) {
        const bucket = inboundByDate.get(leg.date);
        if (bucket) bucket.push(leg);
        else inboundByDate.set(leg.date, [leg]);
      }
    }

    const candidates = [];
    for (const outbound of outboundLegs) {
      for (let nights = minNights; nights <= maxNights; nights++) {
        const returnDate = addDays(outbound.date, nights);
        const bucket = returnDate && inboundByDate.get(returnDate);
        if (!bucket) continue;
        for (const inbound of bucket) {
          const openJaw = describeOpenJaw(outbound, inbound);
          if (openJaw.any ? !allowOpenJaw : !allowRoundTrip) continue;
          const cabins = describeCabins(outbound.cabin, inbound.cabin);
          candidates.push({
            id: `${outbound.from}${outbound.to}${outbound.date}-${inbound.from}${inbound.to}${inbound.date}`,
            outbound,
            inbound,
            nights,
            cabinKey: cabins.key,
            cabinLabel: cabins.label,
            cabinRank: outbound.cabin.rank + inbound.cabin.rank,
            openJaw,
            openJawCount: (openJaw.nordic ? 1 : 0) + (openJaw.nyc ? 1 : 0),
            seatScore: seatScore(outbound, inbound),
          });
        }
      }
    }

    candidates.sort(compareTrips);

    // Shortlist: two itineraries on the same pair of dates are, for the
    // purpose of "which trip should I book", the same trip — only the
    // strongest airport/cabin combination for those dates is worth showing.
    const best = [];
    const seenDatePairs = new Set();
    const perOutboundDate = new Map();
    const perInboundDate = new Map();
    for (const candidate of candidates) {
      if (best.length >= bestLimit) break;
      const outDate = candidate.outbound.date;
      const inDate = candidate.inbound.date;
      const pairKey = `${outDate}|${inDate}`;
      if (seenDatePairs.has(pairKey)) continue;
      if ((perOutboundDate.get(outDate) || 0) >= maxPerDate) continue;
      if ((perInboundDate.get(inDate) || 0) >= maxPerDate) continue;
      seenDatePairs.add(pairKey);
      perOutboundDate.set(outDate, (perOutboundDate.get(outDate) || 0) + 1);
      perInboundDate.set(inDate, (perInboundDate.get(inDate) || 0) + 1);
      best.push(candidate);
    }

    return { best, trips: candidates, total: candidates.length };
  }

  root.TripSuggestions = {
    CABINS,
    DEFAULTS,
    addDays,
    buildTripSuggestions,
    nightsBetween,
  };
})(globalThis);
