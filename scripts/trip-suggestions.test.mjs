import test from "node:test";
import assert from "node:assert/strict";

// The engine ships as a plain browser <script>, so it publishes itself on
// globalThis instead of exporting — importing it for its side effect keeps
// the browser and the test suite on exactly the same code.
await import("../docs/assets/trip-suggestions.js");
const { buildTripSuggestions, addDays, nightsBetween, cityName } = globalThis.TripSuggestions;

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
    const { suggestions } = buildTripSuggestions({
      routes: [route("ARN", "JFK", { "2027-05-01": economy }, { [returnDate]: economy })],
      earliestDate: "2027-01-01",
    });
    assert.equal(suggestions.length === 1, expected, `${nights} nights should be ${expected ? "accepted" : "rejected"}`);
    if (expected) assert.equal(suggestions[0].nights, nights);
  }
});

test("month-boundary trips keep an accurate night count", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [route("CPH", "EWR", { "2027-01-28": business }, { "2027-02-04": business })],
    earliestDate: "2027-01-01",
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].nights, 7);
  assert.equal(suggestions[0].outbound.date, "2027-01-28");
  assert.equal(suggestions[0].inbound.date, "2027-02-04");
});

test("Nordic open jaws are proposed and described", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, {}),
      route("CPH", "JFK", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(suggestions.length, 1);
  const [trip] = suggestions;
  assert.equal(trip.outbound.from, "ARN");
  assert.equal(trip.inbound.to, "CPH");
  assert.deepEqual({ nordic: trip.openJaw.nordic, nyc: trip.openJaw.nyc }, { nordic: true, nyc: false });
  assert.match(trip.openJaw.description, /departs ARN, returns to CPH/);
});

test("JFK/EWR open jaws are proposed and described", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [
      route("OSL", "JFK", { "2027-05-01": business }, {}),
      route("OSL", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(suggestions.length, 1);
  const [trip] = suggestions;
  assert.equal(trip.outbound.to, "JFK");
  assert.equal(trip.inbound.from, "EWR");
  assert.deepEqual({ nordic: trip.openJaw.nordic, nyc: trip.openJaw.nyc }, { nordic: false, nyc: true });
});

test("open jaws at both ends are supported and labelled as such", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, {}),
      route("CPH", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
  });
  assert.equal(suggestions.length, 1);
  const [trip] = suggestions;
  assert.equal(trip.openJawCount, 2);
  assert.match(trip.openJaw.description, /both ends/);
});

test("a plain round trip is preferred over an equally good open jaw", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [
      route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
      route("CPH", "EWR", {}, { "2027-05-08": business }),
    ],
    earliestDate: "2027-01-01",
    maxPerDate: 5,
  });
  assert.equal(suggestions[0].openJaw.any, false);
  assert.equal(suggestions[0].outbound.from, "ARN");
  assert.equal(suggestions[0].inbound.to, "ARN");
});

test("cabins rank Business+Business above mixed above Economy+Economy", () => {
  const { suggestions } = buildTripSuggestions({
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
  assert.deepEqual(
    suggestions.map((trip) => trip.cabinKey),
    ["business", "business", "mixed", "mixed", "economy"]
  );
  assert.equal(suggestions[0].cabinLabel, "Business");
  assert.equal(suggestions.find((trip) => trip.cabinKey === "mixed").cabinLabel, "Mixed cabin");
  assert.equal(suggestions.at(-1).cabinLabel, "Economy");
});

test("mixed cabin keeps each leg's own cabin", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": economy })],
    earliestDate: "2027-01-01",
  });
  const [trip] = suggestions;
  assert.equal(trip.cabinKey, "mixed");
  assert.equal(trip.outbound.cabin.code, "AB");
  assert.equal(trip.inbound.cabin.code, "AG");
});

test("Economy-only availability still produces suggestions", () => {
  const { suggestions } = buildTripSuggestions({
    routes: [route("OSL", "EWR", { "2027-05-01": economy }, { "2027-05-07": economy })],
    earliestDate: "2027-01-01",
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].cabinKey, "economy");
  assert.equal(suggestions[0].nights, 6);
});

test("no valid pair yields an empty list rather than a partial trip", () => {
  for (const routes of [
    [],
    [route("ARN", "JFK", { "2027-05-01": economy }, {})],
    [route("ARN", "JFK", {}, { "2027-05-08": economy })],
    [route("ARN", "JFK", { "2027-05-01": economy }, { "2027-05-03": economy })],
  ]) {
    const { suggestions } = buildTripSuggestions({ routes, earliestDate: "2027-01-01" });
    assert.deepEqual(suggestions, []);
  }
});

test("legs without enough seats, or in a filtered-out cabin, are ignored", () => {
  const routes = [route("ARN", "JFK", { "2027-05-01": { AG: 1, AB: 1 } }, { "2027-05-08": { AG: 3 } })];
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", minSeats: 2 }).suggestions.length, 0);
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-01-01", cabin: "AB" }).suggestions.length, 0);
  const filtered = buildTripSuggestions({ routes, earliestDate: "2027-01-01", cabin: "AG" }).suggestions;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].cabinKey, "economy");
});

test("dates before earliestDate are never suggested", () => {
  const routes = [route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business })];
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-05-02" }).suggestions.length, 0);
  assert.equal(buildTripSuggestions({ routes, earliestDate: "2027-05-01" }).suggestions.length, 1);
});

test("identical date pairs are deduplicated and per-date output stays bounded", () => {
  const routes = [
    route("ARN", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
    route("ARN", "EWR", { "2027-05-01": business }, { "2027-05-08": business }),
    route("CPH", "JFK", { "2027-05-01": business }, { "2027-05-08": business }),
  ];
  const { suggestions, totalCandidates } = buildTripSuggestions({ routes, earliestDate: "2027-01-01" });
  assert.ok(totalCandidates > 1);
  assert.equal(suggestions.length, 1);
});

test("ranking is deterministic regardless of route order", () => {
  const build = (order) =>
    buildTripSuggestions({
      routes: order.map(([home, nyc]) =>
        route(home, nyc, { "2027-05-01": business, "2027-05-04": economy }, { "2027-05-08": economy, "2027-05-11": business })
      ),
      earliestDate: "2027-01-01",
    }).suggestions.map((trip) => trip.id);
  assert.deepEqual(build([["ARN", "JFK"], ["CPH", "EWR"]]), build([["CPH", "EWR"], ["ARN", "JFK"]]));
});

test("city names cover every supported airport", () => {
  assert.deepEqual(
    ["ARN", "CPH", "OSL", "JFK", "EWR"].map(cityName),
    ["Stockholm", "Copenhagen", "Oslo", "New York", "New York"]
  );
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
  const { suggestions } = buildTripSuggestions({ routes, earliestDate: "2000-01-01" });
  assert.ok(suggestions.length > 0);
  for (const trip of suggestions) {
    assert.ok(trip.nights >= 5 && trip.nights <= 10);
    assert.equal(nightsBetween(trip.outbound.date, trip.inbound.date), trip.nights);
    assert.ok(["ARN", "CPH", "OSL"].includes(trip.outbound.from));
    assert.ok(["JFK", "EWR"].includes(trip.outbound.to));
    assert.equal(trip.inbound.to !== trip.outbound.from, trip.openJaw.nordic);
    assert.ok(trip.outbound.seats >= 1 && trip.inbound.seats >= 1);
  }
});
