import test from "node:test";
import assert from "node:assert/strict";

// The engine ships as a plain browser <script>, so it publishes itself on
// globalThis instead of exporting — importing it for its side effect keeps
// the browser and the test suite on exactly the same code.
await import("../docs/assets/trip-suggestions.js");
const { buildTripSuggestions, addDays, nightsBetween } = globalThis.TripSuggestions;

/** Builds a route in the same shape mergeCombo() produces in app.js. */
function route(homeCode, nycCode, outbound, inbound) {
  const toMap = (entries) => new Map(Object.entries(entries).map(([date, counts]) => [date, { AG: 0, AP: 0, AB: 0, ...counts }]));
  return { homeCode, nycCode, outboundMap: toMap(outbound), inboundMap: toMap(inbound) };
}

const economy = { AG: 4 };
const business = { AB: 2 };

test("trip length is counted in whole calendar days across month and year boundaries", () => {
  assert.equal(nightsBetween("2027-01-28", "2027-02-04"), 7);
  assert.equal(nightsBetween("2026-12-28", "2027-01-04"), 7);
  assert.equal(nightsBetween("2028-02-25", "2028-03-01"), 5); // leap year
  assert.equal(addDays("2027-12-27", 5), "2028-01-01");
  assert.equal(addDays("2028-02-26", 5), "2028-03-02");
  assert.ok(Number.isNaN(nightsBetween("2027-02-30", "2027-03-06")));
});

test("exactly 5 and exactly 10 nights are accepted, 4 and 11 are rejected", () => {
  for (const [nights, expected] of [[4, false], [5, true], [10, true], [11, false]]) {
    const returnDate = addDays("2027-05-01", nights);
    const { trips } = buildTripSuggestions({
      routes: [route("ARN", "JFK", { "2027-05-01": economy }, { [returnDate]: economy })],
      earliestDate: "2027-01-01",
    });
    assert.equal(trips.length === 1, expected, `${nights} nights should be ${expected ? "accepted" : "rejected"}`);
    if (expected) assert.equal(trips[0].nights, nights);
  }
});

test("month-boundary trips keep an accurate night count", () => {
  const { trips } = buildTripSuggestions({
    routes: [route("CPH", "EWR", { "2027-01-28": business }, { "2027-02-04": business })],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].nights, 7);
  assert.equal(trips[0].outbound.date, "2027-01-28");
  assert.equal(trips[0].inbound.date, "2027-02-04");
});

test("Nordic open jaws are proposed and described", () => {
  const { trips } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, {}),
      route("CPH", "JFK", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips.length, 1);
  const [trip] = trips;
  assert.equal(trip.outbound.from, "ARN");
  assert.equal(trip.inbound.to, "CPH");
  assert.deepEqual({ nordic: trip.openJaw.nordic, nyc: trip.openJaw.nyc }, { nordic: true, nyc: false });
  assert.match(trip.openJaw.description, /departs ARN, returns to CPH/);
});

test("JFK/EWR open jaws are proposed and described", () => {
  const { trips } = buildTripSuggestions({
    routes: [
      route("OSL", "JFK", { "2027-05-01": business }, {}),
      route("OSL", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips.length, 1);
  const [trip] = trips;
  assert.equal(trip.outbound.to, "JFK");
  assert.equal(trip.inbound.from, "EWR");
  assert.deepEqual({ nordic: trip.openJaw.nordic, nyc: trip.openJaw.nyc }, { nordic: false, nyc: true });
});

test("open jaws at both ends are supported and labelled as such", () => {
  const { trips } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, {}),
      route("CPH", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips.length, 1);
  const [trip] = trips;
  assert.equal(trip.openJawCount, 2);
  assert.match(trip.openJaw.description, /both ends/);
});

test("a plain round trip is preferred over an equally good open jaw", () => {
  const { trips } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
      route("CPH", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips[0].openJaw.any, false);
  assert.equal(trips[0].outbound.from, "ARN");
  assert.equal(trips[0].inbound.to, "ARN");
});

test("cabins rank Business+Business above mixed above Economy+Economy", () => {
  const { trips } = buildTripSuggestions({
    routes: [
      route(
        "ARN",
        "JFK",
        { "2027-05-01": business, "2027-05-02": business, "2027-05-03": economy },
        { "2027-05-08": business, "2027-05-09": economy, "2027-05-10": economy }
      ),
    ],
    earliestDate: "2027-01-01",
  });
  const ranks = trips.map((trip) => trip.cabinRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(trips[0].cabinKey, "business");
  assert.equal(trips[0].cabinLabel, "Business");
  assert.equal(trips.find((trip) => trip.cabinKey === "mixed").cabinLabel, "Mixed cabin");
  assert.equal(trips.at(-1).cabinKey, "economy");
  assert.equal(trips.at(-1).cabinLabel, "Economy");
});

test("mixed cabin keeps each leg's own cabin", () => {
  const { trips } = buildTripSuggestions({
    routes: [route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": economy })],
    earliestDate: "2027-01-01",
  });
  const [trip] = trips;
  assert.equal(trip.cabinKey, "mixed");
  assert.equal(trip.outbound.cabin.code, "AB");
  assert.equal(trip.inbound.cabin.code, "AG");
});

test("Economy-only availability still produces suggestions", () => {
  const { trips } = buildTripSuggestions({
    routes: [route("OSL", "EWR", { "2027-05-01": economy }, { "2027-05-07": economy })],
    earliestDate: "2027-01-01",
  });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].cabinKey, "economy");
  assert.equal(trips[0].nights, 6);
});

test("no valid pair yields an empty list rather than a partial trip", () => {
  for (const routes of [
    [],
    [route("ARN", "JFK", { "2027-05-01": economy }, {})],
    [route("ARN", "JFK", {}, { "2027-05-08": economy })],
    [route("ARN", "JFK", { "2027-05-01": economy }, { "2027-05-03": economy })],
  ]) {
    const { trips, total } = buildTripSuggestions({ routes, earliestDate: "2027-01-01" });
    assert.deepEqual(trips, []);
    assert.equal(total, 0);
  }
});

test("legs without enough seats, or in a filtered-out cabin, are ignored", () => {
  const routes = [route("ARN", "JFK", { "2027-05-01": { AG: 1, AB: 1 } }, { "2027-05-08": { AG: 3 } })];
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", minSeats: 2 }).total, 0);
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", cabin: "AB" }).total, 0);
  const filtered = buildTripSuggestions({ routes, earliestDate: "2027-01-01", cabin: "AG" }).trips;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].cabinKey, "economy");
});

test("dates before earliestDate are never suggested", () => {
  const routes = [route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business })];
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-05-02" }).total, 0);
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-05-01" }).total, 1);
});

test("departureMonth restricts the outbound leg but lets the trip return later", () => {
  const routes = [
    route(
      "ARN",
      "JFK",
      { "2027-04-28": business, "2027-05-28": business, "2027-06-02": business },
      { "2027-05-05": business, "2027-06-04": business, "2027-06-09": business }
    ),
  ];
  const may = buildTripSuggestions({ routes, earliestDate: "2027-01-01", departureMonth: "2027-05" }).trips;
  assert.deepEqual(
    may.map((trip) => [trip.outbound.date, trip.inbound.date]),
    [["2027-05-28", "2027-06-04"]]
  );

  const april = buildTripSuggestions({ routes, earliestDate: "2027-01-01", departureMonth: "2027-04" }).trips;
  assert.deepEqual(
    april.map((trip) => [trip.outbound.date, trip.inbound.date]),
    [["2027-04-28", "2027-05-05"]]
  );

  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", departureMonth: "2027-03" }).total, 0);
  // An absent or malformed month keeps every departure.
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01" }).total, 3);
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", departureMonth: "nope" }).total, 3);
});

test("every airport combination is kept, ranked and uncapped", () => {
  const routes = [
    route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
    route("ARN", "EWR", { "2027-05-01": business }, { "2027-05-08": business }),
    route("CPH", "JFK", { "2027-05-01": economy }, { "2027-05-08": economy }),
  ];
  const { trips, total } = buildTripSuggestions({ routes, earliestDate: "2027-01-01" });
  assert.equal(trips.length, total);
  // 3 outbound legs × 3 inbound legs on the same dates, including open jaws.
  assert.equal(total, 9);
  assert.equal(new Set(trips.map((trip) => trip.id)).size, 9);
  assert.equal(trips[0].cabinKey, "business");
  assert.equal(trips.at(-1).cabinKey, "economy");
  assert.deepEqual(
    trips.map((trip) => trip.cabinRank),
    [...trips.map((trip) => trip.cabinRank)].sort((a, b) => a - b)
  );
});

test("the shortlist deduplicates date pairs and stays a subset of the full list", () => {
  const routes = [
    route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
    route("ARN", "EWR", { "2027-05-01": business }, { "2027-05-08": business }),
    route("CPH", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
  ];
  const { best, trips, total } = buildTripSuggestions({ routes, earliestDate: "2027-01-01" });
  assert.ok(total > 1);
  // Every combination shares one departure/return date pair, so the
  // shortlist keeps only the strongest of them.
  assert.equal(best.length, 1);
  const ids = new Set(trips.map((trip) => trip.id));
  for (const trip of best) assert.ok(ids.has(trip.id));
  assert.equal(best[0].id, trips[0].id);
});

test("the shortlist spreads across dates rather than repeating one departure", () => {
  const routes = [
    route(
      "OSL",
      "JFK",
      { "2027-05-01": business, "2027-05-02": business, "2027-05-03": business },
      { "2027-05-08": business, "2027-05-09": business, "2027-05-10": business }
    ),
  ];
  const { best } = buildTripSuggestions({ routes, earliestDate: "2027-01-01", bestLimit: 4 });
  assert.equal(best.length, 4);
  const perDeparture = new Map();
  for (const trip of best) {
    perDeparture.set(trip.outbound.date, (perDeparture.get(trip.outbound.date) || 0) + 1);
  }
  for (const count of perDeparture.values()) assert.ok(count <= 2);
  assert.equal(new Set(best.map((trip) => `${trip.outbound.date}|${trip.inbound.date}`)).size, 4);
});

test("ranking is deterministic regardless of route order", () => {
  const build = (order) =>
    buildTripSuggestions({
      routes: order.map(([home, nyc]) =>
        route(home, nyc, { "2027-05-01": business, "2027-05-04": economy }, { "2027-05-08": economy, "2027-05-11": business })
      ),
      earliestDate: "2027-01-01",
    }).trips.map((trip) => trip.id);
  assert.deepEqual(build([["ARN", "JFK"], ["CPH", "EWR"]]), build([["CPH", "EWR"], ["ARN", "JFK"]]));
});

test("the real published SAS payload produces bookable, in-range trips", async () => {
  const { readFileSync } = await import("node:fs");
  const payload = JSON.parse(readFileSync(new URL("../docs/data/latest.json", import.meta.url), "utf8"));
  const routes = Object.entries(payload.routes).map(([id, entry]) => {
    const [home, nyc] = id.split("-");
    const availability = entry.response?.[0]?.availability ?? {};
    const toMap = (list) => new Map((list ?? []).map((day) => [day.date, day]));
    return {
      homeCode: home.toUpperCase(),
      nycCode: nyc.toUpperCase(),
      outboundMap: toMap(availability.outbound),
      inboundMap: toMap(availability.inbound),
    };
  });
  const { trips } = buildTripSuggestions({ routes, earliestDate: "2000-01-01" });
  assert.ok(trips.length > 0);
  for (const trip of trips) {
    assert.ok(trip.nights >= 5 && trip.nights <= 10);
    assert.equal(nightsBetween(trip.outbound.date, trip.inbound.date), trip.nights);
    assert.ok(["ARN", "CPH", "OSL"].includes(trip.outbound.from));
    assert.ok(["JFK", "EWR"].includes(trip.outbound.to));
    assert.equal(trip.inbound.to !== trip.outbound.from, trip.openJaw.nordic);
    assert.ok(trip.outbound.seats >= 1 && trip.inbound.seats >= 1);
  }
});
