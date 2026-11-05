import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  WORKER_NAME, appendLine, prune, applyIn, applyOut, classify, launchScript, nextNumber, parseSessionId, readLines, stableId, upgrade,
  workerBrief, type Msg, type Worker,
} from "../bridge/lib.mts";

const base: Worker = { name: "api", id: "w", cwd: "/x", model: "m", n: 1, state: "work", unread: 0, startedAt: 0, lastAt: 0 };
const msg = (kind: Msg["kind"], text: string, id = text): Msg => ({ id, at: 5, kind, text, peer: "api", worker: "api" });

test("stableId is deterministic, UUID-shaped and part-sensitive", () => {
  const id = stableId("pi-crew-worker", "k", "api");
  assert.equal(id, stableId("pi-crew-worker", "k", "api"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, stableId("pi-crew-worker", "k", "api2"));
  assert.notEqual(stableId("a", "bc"), stableId("ab", "c"));
});

test("WORKER_NAME accepts short lowercase names only", () => {
  for (const ok of ["a", "api", "tests-1", "x".repeat(32)]) assert.ok(WORKER_NAME.test(ok), ok);
  for (const bad of ["", "1api", "Api", "a b", "a/b", "-a", "x".repeat(33), "a;rm"]) assert.ok(!WORKER_NAME.test(bad), bad);
});

test("workerBrief names the lead id and carries the task", () => {
  const worker = base;
  const brief = workerBrief({ name: "lead", id: "LEAD-ID" }, worker, "do the thing");
  assert.match(brief, /to: "LEAD-ID"/);
  assert.match(brief, /First task:\ndo the thing$/);
  assert.match(workerBrief({ name: "lead", id: "L" }, worker), /send the lead one line "ready"/);
});

test("parseSessionId reads both agtermctl shapes and rejects junk", () => {
  assert.equal(parseSessionId('{"ok":true,"result":{"id":"s1"}}'), "s1");
  assert.equal(parseSessionId('{"ok":true,"result":{"session":{"id":"s2"}}}'), "s2");
  for (const bad of ["", "not json", '{"ok":false}', '{"result":{"id":5}}']) assert.equal(parseSessionId(bad), undefined);
});

test("launchScript passes hostile values through the shell unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-launch-"));
  const cwd = join(dir, `it's $(touch pwned) "q" \`x\``);
  execFileSync("mkdir", ["-p", cwd]);
  const fake = join(dir, "fake-pi");
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$PI_INTERCOM_STABLE_ID" "$@"\n');
  chmodSync(fake, 0o755);
  const worker = { name: "api", id: "id-1", cwd, model: "router/x; echo boom" };
  const brief = join(dir, "brief $x.md");
  const script = join(dir, "launch.sh");
  writeFileSync(script, launchScript(worker, brief, { PATH: process.env.PATH, PI_CREW_PI_COMMAND: fake }));
  const out = execFileSync("sh", [script], { encoding: "utf8", cwd: dir }).trim().split("\n");
  assert.deepEqual(out.slice(1), ["id-1", "--model", "router/x; echo boom", "--name", "api", `@${brief}`]);
  assert.equal(realpathSync(out[0]!), realpathSync(cwd));
  assert.throws(() => execFileSync("test", ["-e", join(dir, "pwned")]));
});

test("classify reads the Q:/DONE: markers, an intercom ask and a trailing question", () => {
  const cases: Array<[string, boolean, string, string]> = [
    ["Q: drop it?", false, "ask", "drop it?"],
    ["question:  which db", false, "ask", "which db"],
    ["DONE: shipped", false, "done", "shipped"],
    ["done:shipped", false, "done", "shipped"],
    ["tests pass", false, "report", "tests pass"],
    ["found 3 bugs.\nfix them all?", false, "ask", "found 3 bugs.\nfix them all?"],
    ["is it? no, it is fine", false, "report", "is it? no, it is fine"],
    ["plain", true, "ask", "plain"],
    ["  Q:   spaced  ", false, "ask", "spaced"],
  ];
  for (const [text, expects, kind, out] of cases) assert.deepEqual(classify(text, expects), { kind, text: out }, text);
});

test("worker state: ask opens and stays open until the lead answers; done goes idle; gone stays gone", () => {
  let w = applyIn(base, msg("report", "r1"));
  assert.deepEqual([w.state, w.unread, w.last?.text], ["work", 1, "r1"]);
  w = applyIn(w, msg("ask", "which db?"));
  assert.deepEqual([w.state, w.ask?.text, w.unread], ["ask", "which db?", 2]);
  w = applyIn(w, msg("done", "finished"));
  assert.deepEqual([w.state, w.ask?.text], ["ask", "which db?"]);
  w = applyOut(w, msg("out", "postgres"));
  assert.deepEqual([w.state, w.ask, w.unread, w.last?.text], ["work", undefined, 0, "you: postgres"]);
  w = applyIn(w, msg("done", "all good"));
  assert.equal(w.state, "idle");
  const gone = { ...base, state: "gone" as const };
  assert.equal(applyIn(gone, msg("ask", "late?")).state, "gone");
  assert.equal(applyOut(gone, msg("out", "x")).state, "gone");
  assert.equal(applyIn(base, msg("report", "x".repeat(1000))).last!.text.length, 300);
});

test("upgrade numbers 0.1 records in file order and keeps numbers already set", () => {
  const ws = upgrade([{ name: "a", id: "1", cwd: "/", model: "m" }, { name: "b", id: "2", cwd: "/", model: "m", n: 7 }, { name: "c", id: "3", cwd: "/", model: "m" }], 9);
  assert.deepEqual(ws.map(w => [w.name, w.n, w.state, w.unread, w.startedAt]), [["a", 8, "work", 0, 9], ["b", 7, "work", 0, 9], ["c", 9, "work", 0, 9]]);
  assert.equal(nextNumber(ws), 10);
  assert.equal(nextNumber([]), 1);
});

test("appendLine trims to the newest three quarters; readLines skips torn lines", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-crew-feed-")), "feed.jsonl");
  for (let i = 0; i < 9; i++) appendLine(file, { i }, 8);
  assert.deepEqual(readLines<{ i: number }>(file).map(x => x.i), [3, 4, 5, 6, 7, 8]);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"i":`);
  assert.deepEqual(readLines<{ i: number }>(file, 2).map(x => x.i), [7, 8]);
  assert.deepEqual(readLines(join(file, "missing")), []);
});

test("prune forgets stopped workers after their grace time, with their messages, and drops old messages", () => {
  const hour = 3_600_000;
  const now = 100 * hour;
  const ws: Worker[] = [
    { ...base, name: "live", lastAt: 0 },
    { ...base, name: "fresh-gone", state: "gone", lastAt: now - 10 * 60_000 },
    { ...base, name: "old-gone", state: "gone", lastAt: now - hour },
  ];
  const m = (id: string, worker: string | undefined, at: number): Msg => ({ id, at, kind: "report", text: id, peer: worker ?? "x", ...(worker ? { worker } : {}) });
  const feed = [m("old", "live", now - 25 * hour), m("live", "live", now - hour), m("fg", "fresh-gone", now), m("og", "old-gone", now), m("stranger", undefined, now)];
  const kept = prune(ws, feed, now);
  assert.deepEqual(kept.workers.map(w => w.name), ["live", "fresh-gone"]);
  assert.deepEqual(kept.forgotten, ["old-gone"]);
  assert.deepEqual(kept.feed.map(x => x.id), ["live", "fg", "stranger"]);
});

test("prune keeps each worker's newest messages and gives strangers one shared budget", () => {
  const ws: Worker[] = [{ ...base, name: "a" }, { ...base, name: "b" }];
  const m = (id: string, worker?: string): Msg => ({ id, at: 0, kind: "report", text: id, peer: worker ?? id, ...(worker ? { worker } : {}) });
  const feed = [m("a1", "a"), m("b1", "b"), m("a2", "a"), m("x1"), m("a3", "a"), m("x2"), m("x3")];
  assert.deepEqual(prune(ws, feed, 0, 1, 1, 2).feed.map(x => x.id), ["b1", "a2", "a3", "x2", "x3"]);
});
