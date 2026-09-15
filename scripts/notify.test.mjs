import test from "node:test";
import assert from "node:assert/strict";
import { buildMessageBody, buildMessages, sampleMatches } from "./notify.mjs";

test("links use the correct return/outbound route, date and award search", () => {
  const match = sampleMatches()[0];
  for (const [direction, expected] of [["inbound", "JFK-CPH"], ["outbound", "CPH-JFK"]]) {
    const body = buildMessageBody([{ ...match, direction }]);
    const url = new URL(/\[Open on SAS\]\(([^)]+)\)/.exec(body)[1]);
    assert.equal(url.searchParams.get("search"), `OW_${expected}-20270514_a1c0i0y0`);
    assert.equal(url.searchParams.get("bookingFlow"), "points");
  }
});

test("sample uses the real formatter with grouped cabins and a clear test label", () => {
  const sample = sampleMatches();
  const [real] = buildMessages(sample);
  const [demo] = buildMessages(sample, true);
  assert.equal(demo, `🧪 *TEST — sample availability*\n\n${real}`);
  assert.match(demo, /Business 2, Premium Economy 4/);
  assert.equal((demo.match(/\[Open on SAS\]/g) || []).length, 2);
});

test("large alerts keep every match and complete links within message limits", () => {
  const matches = Array.from({ length: 150 }, (_, i) => ({
    ...sampleMatches()[0],
    date: new Date(Date.UTC(2027, 0, i + 1)).toISOString().slice(0, 10),
  }));
  const messages = buildMessages(matches);
  assert.ok(messages.length > 1);
  const links = messages.flatMap((message) => {
    assert.ok(message.length <= 3900);
    return [...message.matchAll(/\[Open on SAS\]\(([^)]+)\)/g)].map((match) => new URL(match[1]));
  });
  assert.equal(links.length, matches.length);
  assert.equal(new Set(links.map((url) => url.searchParams.get("search"))).size, matches.length);
  assert.deepEqual(buildMessages([]), []);
});
