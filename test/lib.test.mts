import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ASK_LIMIT, PREVIEW_LIMIT, WORKER_NAME, appendLine, prune, applyIn, applyOut, classify, defaultBranch, idleDue, idleMs, launchScript, nextNumber, parseDone,
  parseSessionId, readLines, resolveTarget, stableId, trackLive, upgrade, verifyDone, workerBrief, type Git, type Msg, type Worker,
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
  assert.match(brief, /if you changed files, commit first/);
  assert.match(brief, /changes nothing reports the current HEAD/);
  assert.match(brief, /Report the checks you actually ran and their rc; use `tests: none` only if you ran none/);
  assert.match(brief, /After a Q:, DONE: or blocker send, stop and wait/);
  assert.match(brief, /After a progress report, keep working/);
  assert.match(brief, /Progress reports are allowed/);
  assert.match(brief, /First task:\ndo the thing$/);
  assert.match(brief, /working directory is \/x\. Run every command there/);
  for (const field of ["head", "branch", "tests", "rc", "logs"]) assert.match(brief, new RegExp(`^ +${field}: <`, "m"), field);
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

test("an open question keeps far more than the preview, up to its own limit", () => {
  const long = "q".repeat(PREVIEW_LIMIT * 3);
  const w = applyIn(base, msg("ask", long));
  assert.equal(w.ask?.text, long);
  assert.equal(w.last?.text.length, PREVIEW_LIMIT);
  assert.equal(applyIn(base, msg("ask", "q".repeat(ASK_LIMIT + 50))).ask?.text.length, ASK_LIMIT);
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

test("idleMs reads PI_CREW_IDLE_MIN; 0, junk and negatives turn the alert off", () => {
  const cases: Array<[string | undefined, number]> = [[undefined, 600_000], ["", 600_000], ["2", 120_000], ["0.5", 30_000], ["0", 0], ["-1", 0], ["soon", 0]];
  for (const [raw, ms] of cases) assert.equal(idleMs({ PI_CREW_IDLE_MIN: raw }), ms, String(raw));
});

test("trackLive moves `since` only when a session turns idle or busy; a first sighting is fresh until it does", () => {
  const a = trackLive(undefined, { status: "thinking" }, 1);
  const b = trackLive(a, { status: "tool:bash", contextPct: 40 }, 2);
  const c = trackLive(b, { status: "idle · waiting on CI" }, 3);
  const d = trackLive(c, { status: "idle" }, 4);
  assert.deepEqual([a.since, b.since, c.since, d.since], [1, 1, 3, 3]);
  assert.deepEqual([a.fresh, b.fresh, c.fresh, d.fresh], [true, true, undefined, undefined]);
  assert.equal(b.contextPct, 40);
});

test("idleDue: a working worker quiet past the threshold, once per idle stretch", () => {
  const ms = 1000;
  const w: Worker = { ...base, agtermSession: "s", lastAt: 0 };
  const idle = { status: "idle", since: 0 };
  const cases: Array<[string, Worker, Parameters<typeof idleDue>[1], number, boolean]> = [
    ["idle past threshold", w, idle, 1000, true],
    ["idle, not yet", w, idle, 999, false],
    ["busy", w, { status: "thinking", since: 0 }, 5000, false],
    ["off the broker", w, undefined, 1000, true],
    ["waiting on the lead", { ...w, state: "ask" }, idle, 5000, false],
    ["done", { ...w, state: "idle" }, idle, 5000, false],
    ["no agterm session", { ...w, agtermSession: undefined }, idle, 5000, false],
    ["already alerted this stretch", { ...w, alertedAt: 1000 }, idle, 5000, false],
    ["new message after the alert", { ...w, alertedAt: 1000, lastAt: 2000 }, idle, 3000, true],
    ["went idle again after the alert", { ...w, alertedAt: 1000 }, { status: "idle", since: 2000 }, 3000, true],
    ["bridge restarted mid-stretch: no repeat", { ...w, alertedAt: 1000 }, { status: "idle", since: 2000, fresh: true }, 9000, false],
    ["bridge restarted, never alerted", w, { status: "idle", since: 5000, fresh: true }, 1000, true],
    ["dropped off and back after the alert: no repeat", { ...w, alertedAt: 1000 }, undefined, 9000, false],
  ];
  for (const [what, worker, live, now, due] of cases) assert.equal(idleDue(worker, live, now, ms), due, what);
  assert.equal(idleDue(w, idle, 1e9, 0), false, "disabled");
});

test("resolveTarget: worker, exact id, session name in any case, unique id prefix; ambiguity and misses fail with candidates", () => {
  const api: Worker = { ...base, id: "11111111-aaaa-4aaa-8aaa-000000000001" };
  const sessions = [
    { id: "22222222-bbbb-4bbb-8bbb-000000000002", name: "CI-Agent" },
    { id: "33333333-cccc-4ccc-8ccc-000000000003", name: "twin" },
    { id: "33333333-dddd-4ddd-8ddd-000000000004", name: "twin" },
  ];
  assert.deepEqual(resolveTarget("api", [api], sessions), { id: api.id, worker: api });
  const withApi = [...sessions, { id: api.id, name: "api" }];
  for (const to of ["API", api.id, "111111"]) assert.deepEqual(resolveTarget(to, [api], withApi), { id: api.id, worker: api }, `${to} reaches the worker record`);
  assert.equal(resolveTarget(sessions[0]!.id, [api], sessions).id, sessions[0]!.id);
  assert.equal(resolveTarget("ci-agent", [api], sessions).id, sessions[0]!.id);
  assert.equal(resolveTarget("222222", [api], sessions).id, sessions[0]!.id);
  const offline = "44444444-eeee-4eee-8eee-000000000005";
  assert.equal(resolveTarget(offline, [api], sessions).id, offline, "a full id passes through for the broker to queue");
  assert.throws(() => resolveTarget("twin", [api], sessions), /names 2 sessions: twin \(33333333-cccc.*twin \(33333333-dddd/);
  assert.throws(() => resolveTarget("333333", [api], sessions), /prefix of 2 ids/);
  assert.throws(() => resolveTarget("22222", [api], sessions), /no worker or session named "22222"/, "short prefixes do not match");
  assert.throws(() => resolveTarget("nobody", [api], sessions), /no worker or session named "nobody"; live: CI-Agent \(/);
  assert.throws(() => resolveTarget("nobody", [], []), /live: none/);
});

test("parseDone reads the report fields; the last of each wins over a body line that looks like one", () => {
  const text = [
    "fixed verify.sh", "rc: 1 on the first run, fixed the flake", "Branch: rebased onto main", "",
    "head: `abc1234def`", "- branch: feat/x,", "tests: bin/test --filter verify", "rc=0", "logs: /tmp/a.log /tmp/b.log",
  ].join("\n");
  assert.deepEqual(parseDone(text), { head: "abc1234def", branch: "feat/x", tests: "bin/test --filter verify", rc: "0", logs: "/tmp/a.log /tmp/b.log" });
  assert.deepEqual(parseDone("all good"), {});
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const realGit: Git = async (cwd, args) => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-crew-git-")));
  const main = join(dir, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) sh(main, "config", k!, v!);
  writeFileSync(join(main, "a.txt"), "a\n");
  sh(main, "add", ".");
  sh(main, "commit", "-qm", "init");
  const wt = join(dir, "wt");
  sh(main, "worktree", "add", "-q", "-b", "feat/x", wt);
  return { main, wt, head: sh(wt, "rev-parse", "HEAD") };
}

test("defaultBranch: origin HEAD, else main or master", async () => {
  const { main, wt } = repo();
  assert.equal(await defaultBranch(realGit, wt), "main");
  sh(main, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  sh(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal(await defaultBranch(realGit, wt), "trunk");
  assert.equal(await defaultBranch(realGit, mkdtempSync(join(tmpdir(), "pi-crew-nogit-"))), undefined);
});

test("verifyDone checks the claims against the checkout", async () => {
  const { main, wt, head } = repo();
  const good = { head, branch: "feat/x", tests: "bin/test", rc: "0", logs: "none" };
  assert.deepEqual(await verifyDone(good, wt, realGit), { ok: true, notes: [] });
  assert.deepEqual(await verifyDone({ ...good, head: head.slice(0, 7) }, wt, realGit), { ok: true, notes: [] }, "a short sha is enough");

  const bad = await verifyDone({ head: "abc", branch: "feat/y", rc: "1" }, wt, realGit);
  assert.deepEqual(bad.notes, [
    "missing tests, logs",
    "reported rc=1",
    `head abc is not HEAD ${head.slice(0, 12)}`,
    "branch feat/y is not the checked-out feat/x",
  ]);

  writeFileSync(join(wt, "b.txt"), "b\n");
  writeFileSync(join(main, "a.txt"), "escaped\n");
  assert.deepEqual((await verifyDone(good, wt, realGit)).notes, [
    `uncommitted changes in ${wt}: 1 path(s)`,
    `main checkout ${main} has uncommitted changes`,
  ]);
  assert.deepEqual((await verifyDone({ ...good, branch: "main" }, main, realGit)).notes, ["on the default branch main", `uncommitted changes in ${main}: 1 path(s)`]);

  assert.deepEqual((await verifyDone({ ...good, branch: "main" }, main, realGit, true)).notes, [`uncommitted changes in ${main}: 1 path(s)`]);
  assert.deepEqual((await verifyDone({ ...good, branch: "wrong", head: "bad", rc: "1" }, main, realGit, true)).notes, [
    "reported rc=1", `head bad is not HEAD ${head.slice(0, 12)}`, "branch wrong is not the checked-out main", `uncommitted changes in ${main}: 1 path(s)`,
  ]);

  const none = mkdtempSync(join(tmpdir(), "pi-crew-nogit-"));
  assert.deepEqual(await verifyDone(good, none, realGit), { ok: false, notes: [`${none} is not a git checkout; head and branch unchecked`] });
});
