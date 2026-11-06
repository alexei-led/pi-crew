// Drives createCrew with fakes: no broker, no agterm, no git. The wire-level behavior is in bridge.test.mts.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCrew, type CrewDeps, type Incoming, type Peer } from "../bridge/crew.mts";
import { stableId, type Git, type SessionInfo } from "../bridge/lib.mts";
import type { BridgeEvent } from "../types/index.d.ts";

const KEY = "pane-1";
const API_ID = stableId("pi-crew-worker", KEY, "api");
const NO_SESSION = Object.assign(new Error("exit 1"), { stdout: '{"ok":false,"error":"no such session: s1"}' });

type Setup = {
  dir: string;
  crew: ReturnType<typeof createCrew>;
  events: BridgeEvent[];
  agtermCalls: string[][];
  sent: Array<{ to: string; text: string; replyTo?: string }>;
  receipts: string[];
  sessions: SessionInfo[];
  clock: { at: number };
  /** Replaces what the fake agtermctl does for a command. */
  agtermFails: Map<string, unknown>;
  gitOut: Map<string, string>;
  sendResults: Array<{ delivered: boolean; id?: string; reason?: string; code?: string }>;
};

function setup(options: { dir?: string; deps?: Partial<CrewDeps> } = {}): Setup {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const events: BridgeEvent[] = [];
  const agtermCalls: string[][] = [];
  const sent: Setup["sent"] = [];
  const receipts: string[] = [];
  const sessions: SessionInfo[] = [];
  const clock = { at: 1_000_000 };
  const agtermFails = new Map<string, unknown>();
  const gitOut = new Map<string, string>();
  const sendResults: Setup["sendResults"] = [];
  const git: Git = async (_cwd, args) => gitOut.get(args.join(" "));
  const crew = createCrew(dir, {
    key: KEY,
    leadName: "lead",
    emit: event => events.push(event),
    client: {
      listSessions: async () => sessions,
      send: async (to, opts) => {
        sent.push({ to, text: opts.text, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) });
        return sendResults.shift() ?? { delivered: true, id: `sent-${sent.length}` };
      },
      sendMessageReceipt: r => receipts.push(r.messageId),
    },
    agterm: async args => {
      agtermCalls.push(args);
      const fail = agtermFails.get(args.slice(0, 2).join(" "));
      if (fail) throw fail;
      return args[1] === "new" ? '{"ok":true,"result":{"id":"s1"}}' : args[1] === "text" ? "screen\n" : "";
    },
    git,
    now: () => clock.at,
    agtermSession: "lead-pane",
    defaultModel: "test/model",
    exitCheckMs: 0,
    ...options.deps,
  });
  return { dir, crew, events, agtermCalls, sent, receipts, sessions, clock, agtermFails, gitOut, sendResults };
}

const eventsOf = <T extends BridgeEvent["type"]>(s: Setup, type: T) => s.events.filter((e): e is Extract<BridgeEvent, { type: T }> => e.type === type);
const lastWorkers = (s: Setup) => eventsOf(s, "workers").at(-1)!.workers;
const errors = (s: Setup) => eventsOf(s, "error").map(e => e.error);
const json = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const peer = (id: string, name = "api"): Peer => ({ id, name, cwd: "/work" });
const incoming = (id: string, text: string, extra: Partial<Incoming> = {}): Incoming => ({ id, content: { text }, ...extra });
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("spawn records the worker, writes brief and launcher, opens the agterm session after the lead's", async () => {
  const s = setup();
  const { worker } = (await s.crew.handle({ op: "spawn", name: "api", cwd: "/work", task: "build it", group: "backend" })) as { worker: any };
  assert.deepEqual([worker.id, worker.model, worker.n, worker.group, worker.state, worker.agtermSession], [API_ID, "test/model", 1, "backend", "work", "s1"]);
  assert.equal(worker.last.text, "you: build it");
  assert.match(readFileSync(join(s.dir, "workers/api/brief.md"), "utf8"), /First task:\nbuild it$/);
  assert.match(readFileSync(join(s.dir, "workers/api/launch.sh"), "utf8"), /--model 'test\/model'/);
  assert.deepEqual(s.agtermCalls[0]!.slice(0, 5), ["session", "new", "--after", "lead-pane", "--no-select"]);
  assert.equal(json(s.dir, "workers.json")[0].agtermSession, "s1");
  assert.deepEqual(eventsOf(s, "feed").map(e => [e.msg.kind, e.msg.text, e.msg.worker]), [["out", "build it", "api"]]);
});

test("spawn is refused for a bad name or group, a duplicate, a missing agterm, or the default branch", async () => {
  const s = setup();
  await assert.rejects(s.crew.handle({ op: "spawn", name: "Bad Name", cwd: "/w" }), /worker name must match/);
  await assert.rejects(s.crew.handle({ op: "spawn", name: "ok", cwd: "/w", group: "Bad" }), /group must match/);
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  await assert.rejects(s.crew.handle({ op: "spawn", name: "api", cwd: "/w" }), /already exists; stop it first/);
  const both = await Promise.allSettled([1, 2].map(() => s.crew.handle({ op: "spawn", name: "dup", cwd: "/w" })));
  assert.deepEqual(both.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  s.gitOut.set("branch --show-current", "main");
  s.gitOut.set("symbolic-ref --short refs/remotes/origin/HEAD", "origin/main");
  await assert.rejects(s.crew.handle({ op: "spawn", name: "edit", cwd: "/repo", task: "x" }), /on the default branch main/);
  assert.ok(await s.crew.handle({ op: "spawn", name: "edit", cwd: "/repo", task: "x", allowDefaultBranch: true }));
  const outside = setup({ deps: { agtermSession: undefined } });
  await assert.rejects(outside.crew.handle({ op: "spawn", name: "api", cwd: "/w" }), /not running inside agterm/);
});

test("a failed agterm session leaves the worker gone and says why", async () => {
  const s = setup();
  s.agtermFails.set("session new", new Error("agtermctl exploded"));
  await assert.rejects(s.crew.handle({ op: "spawn", name: "api", cwd: "/w" }), /agtermctl session new failed: agtermctl exploded/);
  assert.equal(lastWorkers(s)[0]!.state, "gone");
  s.agtermFails.clear();
  const again = (await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" })) as { worker: { n: number } };
  assert.equal(again.worker.n, 2, "a gone name can be spawned again, with a new number");
});

test("send to a worker by name goes to its id and updates the record and the feed", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.crew.onMessage(peer(API_ID), incoming("r1", "progress"));
  assert.equal(lastWorkers(s)[0]!.unread, 1);
  const reply = (await s.crew.handle({ op: "send", to: "api", text: "next task" })) as { to: string; delivered: boolean };
  assert.deepEqual([reply.to, reply.delivered, s.sent], [API_ID, true, [{ to: API_ID, text: "next task" }]]);
  const w = lastWorkers(s)[0]!;
  assert.deepEqual([w.state, w.unread, w.last!.text], ["work", 0, "you: next task"]);
  assert.deepEqual(eventsOf(s, "feed").at(-1)!.msg.kind, "out");
});

test("send that the broker does not deliver is an error and records nothing", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.sendResults.push({ delivered: false, reason: "offline", code: "E_OFFLINE" });
  await assert.rejects(s.crew.handle({ op: "send", to: "api", text: "x" }), /not delivered to api: offline \(E_OFFLINE\)/);
  assert.equal(eventsOf(s, "feed").length, 0);
});

test("a Q: report opens a question, the reply closes it; an ask is answered with replyTo until the broker drops it", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.crew.onMessage(peer(API_ID), incoming("q1", "Q: drop the table?"));
  s.crew.onMessage(peer(API_ID), incoming("a1", "which port?", { expectsReply: true }));
  assert.deepEqual(s.receipts, ["q1", "a1"]);
  const asked = lastWorkers(s)[0]!;
  assert.deepEqual([asked.state, asked.ask!.text, asked.unread], ["ask", "which port?", 2]);
  assert.deepEqual(Object.keys(json(s.dir, "asks.json")), ["a1"], "only the intercom ask is answerable with replyTo");
  assert.deepEqual(json(s.dir, "inbox.json").map((m: any) => m.id), ["q1", "a1"]);

  await s.crew.handle({ op: "send", to: "api", text: "8080", replyTo: "a1" });
  assert.deepEqual(s.sent[0], { to: API_ID, text: "8080", replyTo: "a1" });
  assert.deepEqual(json(s.dir, "asks.json"), {});
  assert.deepEqual([lastWorkers(s)[0]!.state, lastWorkers(s)[0]!.ask], ["work", undefined]);

  s.crew.onMessage(peer(API_ID), incoming("a2", "which host?", { expectsReply: true }));
  s.sendResults.push({ delivered: false, code: "E_REPLY_TARGET" });
  await s.crew.handle({ op: "send", to: "api", text: "localhost", replyTo: "a2" });
  assert.deepEqual(s.sent.slice(-2), [{ to: API_ID, text: "localhost", replyTo: "a2" }, { to: API_ID, text: "localhost" }]);
  assert.deepEqual(json(s.dir, "asks.json"), {});
});

test("a message seen twice is stored once but receipted both times; ack drops it from the inbox", async () => {
  const s = setup();
  s.crew.onMessage(peer("stranger-id", "ci"), incoming("m1", "hello"));
  s.crew.onMessage(peer("stranger-id", "ci"), incoming("m1", "hello"));
  assert.deepEqual(s.receipts, ["m1", "m1"]);
  assert.equal(eventsOf(s, "feed").length, 1);
  assert.equal(eventsOf(s, "feed")[0]!.msg.peer, "ci");
  assert.equal(json(s.dir, "inbox.json").length, 1);
  assert.deepEqual(await s.crew.handle({ op: "ack", id: "m1" }), { acked: "m1" });
  assert.deepEqual(json(s.dir, "inbox.json"), []);
});

test("reports are held until ready, then arrive in order; a DONE carries the git checks and is stored with them", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  const head = "a".repeat(40);
  for (const [args, out] of [["rev-parse HEAD", head], ["branch --show-current", "feat/x"], ["status --porcelain", ""], ["worktree list --porcelain", "worktree /w"], ["rev-parse --show-toplevel", "/w"]]) s.gitOut.set(args!, out!);
  s.crew.onMessage(peer(API_ID), incoming("p1", "progress"));
  s.crew.onMessage(peer(API_ID), incoming("d1", `DONE: shipped\nhead: ${head}\nbranch: feat/x\ntests: bin/test\nrc: 0\nlogs: none`));
  s.crew.onMessage(peer(API_ID), incoming("d2", "DONE: trust me"));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(eventsOf(s, "message").length, 0, "nothing before ready");
  s.crew.ready();
  await until(() => eventsOf(s, "message").length === 3, "three messages");
  const types = s.events.map(e => e.type);
  assert.ok(types.indexOf("ready") < types.indexOf("message"));
  const [p1, d1, d2] = eventsOf(s, "message") as any[];
  assert.deepEqual([p1.id, d1.id, d2.id], ["p1", "d1", "d2"]);
  assert.equal(p1.checks, undefined);
  assert.deepEqual(d1.checks, { ok: true, notes: [] });
  assert.equal(d2.checks.ok, false);
  assert.match(d2.checks.notes[0], /^missing head, branch, tests, rc, logs$/);
  assert.deepEqual(json(s.dir, "inbox.json").find((m: any) => m.id === "d1").checks, { ok: true, notes: [] });
  assert.equal(lastWorkers(s)[0]!.state, "idle");
});

test("a DONE left in the inbox by an earlier run is announced with its checks redone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const first = setup({ dir });
  await first.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  first.crew.onMessage(peer(API_ID), incoming("d1", "DONE: shipped"));
  const second = setup({ dir });
  second.crew.ready();
  await until(() => eventsOf(second, "message").length === 1, "the replayed DONE");
  const [done] = eventsOf(second, "message") as any[];
  assert.equal(done.id, "d1");
  assert.equal(done.checks.ok, false);
  assert.equal(json(dir, "inbox.json")[0].checks.ok, false);
});

test("stop closes the session and marks the worker gone; a second stop forgets it", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "t" });
  assert.deepEqual(await s.crew.handle({ op: "stop", name: "api" }), { stopped: "api" });
  assert.deepEqual(s.agtermCalls.at(-1), ["session", "close", "--target", "s1"]);
  const w = lastWorkers(s)[0]!;
  assert.deepEqual([w.state, w.agtermSession, w.ask], ["gone", undefined, undefined]);
  assert.deepEqual(await s.crew.handle({ op: "stop", name: "api" }), { forgot: "api" });
  assert.deepEqual(json(s.dir, "workers.json"), []);
  assert.doesNotMatch(readFileSync(join(s.dir, "feed.jsonl"), "utf8"), /"worker":"api"/, "its messages go with it");
  await assert.rejects(s.crew.handle({ op: "stop", name: "api" }), /no worker named api/);
});

test("stop keeps the record when the close fails, and treats an already closed session as stopped", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "t" });
  s.agtermFails.set("session close", Object.assign(new Error("exit 1"), { stdout: '{"error":"busy"}' }));
  await assert.rejects(s.crew.handle({ op: "stop", name: "api" }), /close failed: .*busy/);
  assert.equal(json(s.dir, "workers.json")[0].state, "work");
  s.agtermFails.set("session close", NO_SESSION);
  assert.deepEqual(await s.crew.handle({ op: "stop", name: "api" }), { stopped: "api" });
});

test("checkExited marks a worker gone once it left the broker and its session is closed", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "t" });
  s.sessions.push({ id: API_ID });
  await s.crew.checkExited("api");
  assert.equal(lastWorkers(s)[0]!.state, "work", "still on the broker");
  s.sessions.length = 0;
  await s.crew.checkExited("api");
  assert.equal(lastWorkers(s)[0]!.state, "work", "off the broker but its session is open");
  s.agtermFails.set("session text", NO_SESSION);
  await s.crew.checkExited("api");
  assert.deepEqual([lastWorkers(s)[0]!.state, lastWorkers(s)[0]!.agtermSession], ["gone", undefined]);
});

test("checkIdle alerts once per idle stretch with the tail of the worker's screen", async () => {
  const s = setup({ deps: { idleMs: 60_000 } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "t" });
  await s.crew.checkIdle();
  assert.equal(eventsOf(s, "message").length, 0, "not quiet long enough");
  s.clock.at += 5 * 60_000;
  await s.crew.checkIdle();
  await s.crew.checkIdle();
  s.crew.ready();
  await until(() => eventsOf(s, "message").length === 1, "the idle alert");
  const [alert] = eventsOf(s, "message");
  assert.equal(alert!.kind, "idle");
  assert.match(alert!.text, /^not on intercom; no message for 5m, last message 5m ago, with no Q: or DONE:\.\n\nLast 15 lines.*:\nscreen$/);
  assert.deepEqual(s.agtermCalls.at(-1), ["session", "text", "--target", "s1", "--lines", "15"]);
});

test("list gives one row per worker and the live sessions without the lead", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.crew.onMessage(peer(API_ID), incoming("q1", "Q: merge?"));
  s.sessions.push({ id: API_ID, name: "api", status: "idle" }, { id: s.crew.lead.id, name: "lead" });
  const { crew, sessions } = (await s.crew.handle({ op: "list" })) as { crew: any[]; sessions: any[] };
  assert.deepEqual([crew[0].name, crew[0].waitingOnLead, crew[0].question, crew[0].live], ["api", true, "merge?", "idle"]);
  assert.deepEqual(sessions.map(x => [x.id, x.worker]), [[API_ID, "api"]]);
});

test("a malformed request is a clear error, not a crash, and changes nothing", async () => {
  const s = setup();
  for (const [req, message] of [
    ["list", /must be a JSON object/],
    [null, /must be a JSON object/],
    [{ op: "nope" }, /unknown op "nope"/],
    [{ op: "spawn", name: "api" }, /spawn: "cwd" must be a string/],
    [{ op: "spawn", name: 5, cwd: "/w" }, /spawn: "name" must be a string/],
    [{ op: "send", to: "api", text: 7 }, /send: "text" must be a string/],
    [{ op: "spawn", name: "api", cwd: "/w", task: ["x"] }, /"task" must be a string/],
  ] as const) await assert.rejects(s.crew.handle(req), message);
  assert.deepEqual([s.events, s.agtermCalls], [[], []]);
});

test("a corrupt state file is set aside, reported, and not overwritten by the next save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  writeFileSync(join(dir, "inbox.json"), '[{"id":"d1","kind":"done"');
  writeFileSync(join(dir, "workers.json"), '{"not":"a list"}');
  writeFileSync(join(dir, "asks.json"), '{"a1":"yesterday"}');
  const s = setup({ dir });
  assert.equal(errors(s).length, 3);
  assert.match(errors(s).join("\n"), /inbox\.json: .*; kept as inbox\.json\.bad-1000000/);
  assert.match(errors(s).join("\n"), /workers\.json: unexpected content; kept as workers\.json\.bad-1000000/);
  assert.match(errors(s).join("\n"), /asks\.json: unexpected content; kept as asks\.json\.bad-1000000/);
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.crew.onMessage(peer(API_ID), incoming("m1", "hello"));
  assert.equal(readFileSync(join(dir, "inbox.json.bad-1000000"), "utf8"), '[{"id":"d1","kind":"done"');
  assert.equal(readFileSync(join(dir, "workers.json.bad-1000000"), "utf8"), '{"not":"a list"}');
  assert.deepEqual(json(dir, "inbox.json").map((m: any) => m.id), ["m1"]);
});

test("a state file that is missing is empty without a fuss; worker records without an identity are dropped with a note", async () => {
  const fresh = setup();
  assert.deepEqual(errors(fresh), []);
  assert.deepEqual(readdirSync(fresh.dir), []);
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const ok = { name: "api", id: API_ID, cwd: "/w", model: "m", n: 1, state: "work", unread: 0, startedAt: 1, lastAt: 1 };
  writeFileSync(join(dir, "workers.json"), JSON.stringify([ok, { name: "ghost" }, null]));
  const s = setup({ dir });
  assert.match(errors(s)[0]!, /workers\.json: dropped 2 record\(s\) without name, id, cwd or model/);
  s.crew.ready();
  assert.deepEqual(eventsOf(s, "ready")[0]!.workers.map(w => w.name), ["api"]);
  assert.ok(!existsSync(join(dir, "workers.json.bad-1000000")), "a readable list is not set aside");
});
