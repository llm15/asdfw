import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HISTORY_VERSION,
  appendSnapshot,
  normalizeHistory,
  pruneHistory,
  snapshotFromPayload,
} from "./build-history.mjs";

function payload(routes) {
  return {
    updatedAt: "2026-10-01T06:00:00.000Z",
    routes: Object.fromEntries(
      Object.entries(routes).map(([comboId, availability]) => [
        comboId,
        availability === "failed"
          ? { status: "error", error: "boom" }
          : {
              status: "ok",
              response: [{ airportCode: comboId.split("-")[1].toUpperCase(), availability }],
            },
      ])
    ),
  };
}

function record(history, routes, runIso, options) {
  return appendSnapshot(history, snapshotFromPayload(payload(routes)), runIso, options);
}

test("a snapshot flattens both directions and separates failed routes", () => {
  const { counts, okRoutes } = snapshotFromPayload(
    payload({
      "arn-jfk": {
        inbound: [{ date: "2027-05-04", AG: 10, AP: 1 }],
        outbound: [{ date: "2027-05-20", AB: 2 }],
      },
      "cph-ewr": "failed",
    })
  );
  assert.deepEqual(counts.get("arn-jfk|inbound|2027-05-04"), [10, 1, 0]);
  assert.deepEqual(counts.get("arn-jfk|outbound|2027-05-20"), [0, 0, 2]);
  assert.deepEqual([...okRoutes], ["arn-jfk"]);
});

test("only actual changes are recorded, so unchanged dates cost nothing", () => {
  const first = record(null, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 2 }] } }, "t1");
  assert.equal(first.changed, 1);
  assert.deepEqual(first.history.series["arn-jfk|inbound|2027-05-04"], [[0, 0, 0, 2]]);

  const same = record(first.history, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 2 }] } }, "t2");
  assert.equal(same.changed, 0);
  assert.deepEqual(same.history.series["arn-jfk|inbound|2027-05-04"], [[0, 0, 0, 2]]);
  assert.deepEqual(same.history.runs, ["t1", "t2"]);

  const moved = record(same.history, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 4 }] } }, "t3");
  assert.equal(moved.changed, 1);
  assert.deepEqual(moved.history.series["arn-jfk|inbound|2027-05-04"], [
    [0, 0, 0, 2],
    [2, 0, 0, 4],
  ]);
});

test("a date that disappears is recorded as zero, but only for routes that answered", () => {
  const seeded = record(
    null,
    {
      "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 2 }] },
      "cph-ewr": { inbound: [{ date: "2027-05-05", AB: 1 }] },
    },
    "t1"
  );

  const gone = record(seeded.history, { "arn-jfk": { inbound: [] }, "cph-ewr": "failed" }, "t2");
  assert.deepEqual(gone.history.series["arn-jfk|inbound|2027-05-04"], [
    [0, 0, 0, 2],
    [1, 0, 0, 0],
  ]);
  // The failed route keeps its history rather than reporting a phantom loss.
  assert.deepEqual(gone.history.series["cph-ewr|inbound|2027-05-05"], [[0, 0, 0, 1]]);

  // ...and it is not recorded as lost twice while it stays gone.
  const still = record(gone.history, { "arn-jfk": { inbound: [] } }, "t3");
  assert.equal(still.changed, 0);
});

test("re-running the same fetch instant never duplicates a run", () => {
  const first = record(null, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 2 }] } }, "t1");
  const again = record(first.history, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: 9 }] } }, "t1");
  assert.equal(again.skipped, true);
  assert.deepEqual(again.history.runs, ["t1"]);
  assert.deepEqual(again.history.series["arn-jfk|inbound|2027-05-04"], [[0, 0, 0, 2]]);
});

test("pruning keeps the current counts as a rebased baseline", () => {
  let history = null;
  for (const [index, seats] of [2, 3, 4, 5].entries()) {
    history = record(history, { "arn-jfk": { inbound: [{ date: "2027-05-04", AB: seats }] } }, `t${index}`).history;
  }
  const pruned = pruneHistory(history, { maxRuns: 2 });
  assert.deepEqual(pruned.runs, ["t2", "t3"]);
  assert.deepEqual(pruned.series["arn-jfk|inbound|2027-05-04"], [
    [0, 0, 0, 4],
    [1, 0, 0, 5],
  ]);
  // Every point still refers to a run that exists.
  for (const points of Object.values(pruned.series)) {
    for (const [runIndex] of points) assert.ok(runIndex < pruned.runs.length);
  }
});

test("departed dates and never-available dates are dropped", () => {
  const seeded = record(
    null,
    {
      "arn-jfk": {
        inbound: [
          { date: "2026-01-02", AB: 2 },
          { date: "2027-05-04", AB: 2 },
          { date: "2027-06-01", AB: 0, AG: 0 },
        ],
      },
    },
    "t1",
    { today: "2026-10-01" }
  );
  assert.deepEqual(Object.keys(seeded.history.series), ["arn-jfk|inbound|2027-05-04"]);
});

test("a corrupt or foreign history file degrades to an empty one", () => {
  for (const raw of [null, "nope", { version: 99 }, { version: HISTORY_VERSION, runs: "x", series: 4 }]) {
    const normalized = normalizeHistory(raw);
    assert.equal(normalized.version, HISTORY_VERSION);
    assert.deepEqual(normalized.runs, []);
    assert.deepEqual(normalized.series, {});
  }
  // Points that reference runs which no longer exist are discarded.
  const salvaged = normalizeHistory({
    version: HISTORY_VERSION,
    runs: ["t1"],
    series: { "arn-jfk|inbound|2027-05-04": [[0, 1, 0, 0], [7, 9, 9, 9]] },
  });
  assert.deepEqual(salvaged.series["arn-jfk|inbound|2027-05-04"], [[0, 1, 0, 0]]);
});

test("the real published payload produces a usable history", async () => {
  const real = JSON.parse(await readFile(new URL("../docs/data/latest.json", import.meta.url), "utf8"));
  const snapshot = snapshotFromPayload(real);
  assert.ok(snapshot.okRoutes.size > 0);
  assert.ok(snapshot.counts.size > 50);

  const { history, changed } = appendSnapshot(null, snapshot, real.updatedAt, { today: "2026-10-01" });
  // Every recorded change survives unless pruning drops its date entirely.
  assert.ok(changed >= Object.keys(history.series).length);
  assert.ok(Object.keys(history.series).length > 50);
  for (const [key, points] of Object.entries(history.series)) {
    const [comboId, direction, date] = key.split("|");
    assert.match(comboId, /^(arn|osl|cph)-(jfk|ewr)$/);
    assert.ok(direction === "inbound" || direction === "outbound");
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(points[0][0], 0);
    assert.ok(points[0].slice(1).some((n) => n > 0));
  }
});
