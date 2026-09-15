import test from "node:test";
import assert from "node:assert/strict";
import { buildUrl, parseReturnRows, buildAvailabilityList, fetchReturnPage } from "./fetch-roamsnap-data.mjs";

const row = (business = "2seats", flight = "SK916") => ({
  href: "https://www.flysas.com/en/book/flights?search=OW_JFK-CPH-20270501_a1c0i0y0&bookingFlow=points",
  flight: `JFK–CPH · ${flight}`, business,
});
const snapshot = (rows, extra = {}) => ({ isInbound: true, total: rows.length, rows, next: null, ...extra });
const fakePage = (snapshots) => {
  let index = -1;
  return {
    urls: [],
    async goto(url) { this.urls.push(url); index++; return { ok: () => true }; },
    async waitForSelector() {},
    async evaluate() { return snapshots[index]; },
  };
};

test("uses return URLs for both NYC airports", () => {
  assert.equal(buildUrl("JFK"), "https://roamsnap.com/sas/jfk?sdir=in");
  assert.equal(buildUrl("EWR"), "https://roamsnap.com/sas/ewr?sdir=in");
});

test("parses Business counts, excluding other-cabin-only departures", () => {
  const result = parseReturnRows(snapshot([row("9+seats"), row("–", "SK914")]), "JFK");
  assert.equal(result.rowCount, 2);
  assert.deepEqual(buildAvailabilityList(result.rowsByHub.get("CPH")), [{
    date: "2027-05-01", AG: 0, AP: 0, AB: 9, availableSeatsTotal: 9, flightNumbers: ["SK916"],
  }]);
});

test("fails closed for broken markup, wrong direction, invalid dates and duplicates", () => {
  for (const broken of [
    snapshot([row(null)]), snapshot([row()], { isInbound: false }),
    snapshot([row()], { total: null }), snapshot([row(), row()]),
    snapshot([{ ...row(), href: row().href.replace("JFK-CPH", "CPH-JFK") }]),
    snapshot([{ ...row(), href: row().href.replace("20270501", "20270230") }]),
  ]) assert.throws(() => parseReturnRows(broken, "JFK"));
});

test("cumulative pagination does not double count earlier departures", async () => {
  const page = fakePage([
    snapshot([row()], { total: 2, next: "/sas/jfk?sdir=in&shown=48" }),
    snapshot([row(), row("1seat", "SK914")]),
  ]);
  const result = await fetchReturnPage(page, "JFK");
  assert.equal(page.urls.length, 2);
  assert.equal(buildAvailabilityList(result.rowsByHub.get("CPH"))[0].AB, 3);
});

test("accepts a confirmed empty return page", async () => {
  const result = await fetchReturnPage(fakePage([snapshot([])]), "JFK");
  assert.equal(result.rowCount, 0);
});

test("rejects incomplete results, stalled pagination and outbound pagination", async () => {
  await assert.rejects(fetchReturnPage(fakePage([snapshot([row()], { total: 2 })]), "JFK"), /incomplete/);
  const first = snapshot([row()], { total: 2, next: "/sas/jfk?sdir=in&shown=48" });
  await assert.rejects(fetchReturnPage(fakePage([first, first]), "JFK"), /no progress/);
  await assert.rejects(fetchReturnPage(fakePage([
    snapshot([row()], { total: 2, next: "/sas/jfk?shown=48" }),
  ]), "JFK"), /pagination target/);
});
