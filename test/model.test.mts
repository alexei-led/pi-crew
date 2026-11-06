import { strict as assert } from "node:assert";
import { test } from "node:test";

import { age, checksLine, clampText, clip, fold, groups, inboxOrder, nextQuestion, tally, turnHead, turnText } from "../hooks/model.ts";
import type { CrewWorker } from "../types/index.d.ts";

const w = (name: string, n: number, more: Partial<CrewWorker> = {}): CrewWorker => ({
  name, n, id: name, cwd: "/", model: "m", state: "work", unread: 0, startedAt: 0, lastAt: n, ...more,
});

test("age buckets", () => {
  const cases: Array<[number, string]> = [[0, "now"], [59_999, "now"], [60_000, "1m"], [3_599_999, "59m"], [3_600_000, "1h"], [86_400_000, "1d"], [-5, "now"]];
  for (const [ms, out] of cases) assert.equal(age(0, ms), out, String(ms));
});

test("tally counts states, live crew and unread", () => {
  const t = tally([w("a", 1, { state: "ask", unread: 2 }), w("b", 2), w("c", 3, { state: "idle", unread: 1 }), w("d", 4, { state: "gone" })]);
  assert.deepEqual(t, { crew: 3, ask: 1, work: 1, idle: 1, gone: 1, unread: 3 });
});

test("inbox: oldest question first, then unread, then by activity; stopped last", () => {
  const ws = [
    w("gone", 1, { state: "gone", lastAt: 99 }),
    w("quiet", 2, { lastAt: 50 }),
    w("late-ask", 3, { state: "ask", ask: { id: "x", at: 40, text: "?" } }),
    w("unread", 4, { unread: 1, lastAt: 10 }),
    w("early-ask", 5, { state: "ask", ask: { id: "y", at: 20, text: "?" } }),
    w("busy", 6, { lastAt: 60 }),
  ];
  assert.deepEqual(inboxOrder(ws).map(x => x.name), ["early-ask", "late-ask", "unread", "busy", "quiet", "gone"]);
  assert.equal(nextQuestion(ws)?.name, "early-ask");
  assert.equal(nextQuestion([w("a", 1)]), undefined);
});

test("groups keep first-spawn order and number order inside", () => {
  const g = groups([w("c", 3, { group: "web" }), w("a", 1, { group: "api" }), w("b", 2), w("d", 4, { group: "api" })]);
  assert.deepEqual(g.map(x => [x.name, x.workers.map(y => y.n)]), [["api", [1, 4]], ["crew", [2]], ["web", [3]]]);
});

test("fold keeps the newest and counts the rest", () => {
  assert.deepEqual(fold([1, 2, 3, 4], 2), { hidden: 2, shown: [3, 4] });
  assert.deepEqual(fold([1], 2), { hidden: 0, shown: [1] });
});

test("clampText wraps long lines and cuts at the line budget", () => {
  assert.deepEqual(clampText("abcdef\nxy", 5, 4), { text: "abcd\nef\nxy", more: false });
  assert.deepEqual(clampText("abcdef\nxy", 2, 4), { text: "abcd\nef", more: true });
  assert.deepEqual(clampText("a\n\nb", 3, 4), { text: "a\n\nb", more: false });
  assert.equal(clip("hello", 3), "he…");
  assert.equal(clip("hi", 3), "hi");
  assert.equal(clip("hello", 0), "");
  assert.equal(clip("hello", -1), "");
});

test("turnHead uses the same glyph, number and name as the pane", () => {
  const api = w("api", 3);
  assert.equal(turnHead(api, "ask", "api"), "◆ Worker 3 api asks");
  assert.equal(turnHead(api, "done", "api"), "○ Worker 3 api reports done");
  assert.equal(turnHead(api, "report", "api"), "● Worker 3 api reports");
  assert.equal(turnHead(api, "idle", "api"), "◇ Worker 3 api is idle without a report");
  assert.match(turnHead(undefined, "report", "stranger"), /"stranger" \(not a crew worker\)/);
});

test("checksLine passes a verified DONE on and marks a failed one unverified", () => {
  assert.equal(checksLine(undefined), "");
  assert.match(checksLine({ ok: true, notes: [] }), /^DONE checks passed: .*Still review the work itself\.$/);
  assert.equal(
    checksLine({ ok: false, notes: ["missing rc", "uncommitted changes in /w: 2 path(s)"] }),
    "DONE checks failed: missing rc; uncommitted changes in /w: 2 path(s). Treat the report as unverified.",
  );
});


test("turn text puts the headline, answer instruction and metadata on separate lines", () => {
  const event = { type: "message" as const, kind: "ask" as const, id: "q1", expectsReply: true, from: { id: "session", cwd: "/w", worker: "api" }, text: "Question?" };
  assert.deepEqual(turnText(w("api", 3), event).split("\n"), [
    "◆ Worker 3 api asks",
    'Answer with mcp__pi-crew__send to "api" replyTo "q1".',
    "intercom id session, cwd /w, message q1", "", "Question?",
  ]);
  const done = turnText(w("api", 3), { ...event, kind: "done", checks: { ok: true, notes: [] }, replyTo: "task" }, ["ship it"]).split("\n");
  assert.equal(done[0], "○ Worker 3 api reports done");
  assert.equal(done[1], "intercom id session, cwd /w, message q1, in reply to task");
  assert.match(done[2]!, /^DONE checks passed:/);
  assert.match(done[3]!, /user wrote to api.*"ship it"/);
  assert.deepEqual(done.slice(4), ["", "Question?"]);
});


test("idle turn instruction follows the headline before metadata", () => {
  const lines = turnText(w("api", 3), { type: "message", kind: "idle", id: "idle", expectsReply: false, from: { id: "session", cwd: "/w", worker: "api" }, text: "screen" }).split("\n");
  assert.equal(lines[0], "◇ Worker 3 api is idle without a report");
  assert.equal(lines[1], 'Check it: its screen below, mcp__pi-crew__send to nudge "api", or mcp__pi-crew__stop.');
  assert.equal(lines[2], "intercom id session, cwd /w, message idle");
  assert.deepEqual(lines.slice(3), ["", "screen"]);
});
