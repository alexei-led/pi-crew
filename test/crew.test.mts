// Drives createCrew with fakes: no broker, no agterm, no git. The wire-level behavior is in bridge.test.mts.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCrew, type Crew, type CrewDeps, type Incoming, type Peer } from "../bridge/crew.mts";
import { readLines, stableId, type Git, type SessionInfo } from "../bridge/lib.mts";
import type { BridgeEvent } from "../types/index.d.ts";

const KEY = "pane-1";
const API_ID = stableId("pi-crew-worker", KEY, "api");
const NO_SESSION = Object.assign(new Error("exit 1"), { stdout: '{"ok":false,"error":"no such session: s1"}' });

type Setup = {
  dir: string;
  crew: Crew;
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
  const { worker } = (await s.crew.handle({
    op: "spawn",
    name: "api",
    cwd: "/work",
    task: "build it",
    group: "backend",
  })) as { worker: any };
  assert.deepEqual(
    [worker.id, worker.model, worker.n, worker.group, worker.state, worker.agtermSession],
    [API_ID, "test/model", 1, "backend", "work", "s1"],
  );
  assert.equal(typeof worker.runId, "string");
  assert.deepEqual(worker.task, { text: "build it", at: s.clock.at });
  assert.equal(worker.last.text, "you: build it");
  assert.match(readFileSync(join(s.dir, "workers/api/brief.md"), "utf8"), /First task:\nbuild it$/);
  assert.match(readFileSync(join(s.dir, "workers/api/launch.sh"), "utf8"), /--model 'test\/model'/);
  assert.deepEqual(s.agtermCalls[0]!.slice(0, 5), [
    "session",
    "new",
    "--after",
    "lead-pane",
    "--no-select",
  ]);
  assert.equal(json(s.dir, "workers.json")[0].agtermSession, "s1");
  assert.deepEqual(
    eventsOf(s, "feed").map((e) => [e.msg.kind, e.msg.text, e.msg.worker]),
    [["out", "build it", "api"]],
  );
  assert.deepEqual(
    [eventsOf(s, "feed")[0]!.msg.sender, eventsOf(s, "feed")[0]!.msg.runId],
    ["lead", worker.runId],
  );
  const restarted = setup({ dir: s.dir });
  const history = (await restarted.crew.handle({ op: "history", name: "api" })) as {
    runId: string;
  };
  assert.equal(history.runId, worker.runId, "the persisted run identity survives bridge restart");
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

test("send tasks update only when explicitly named and delivered", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "initial task" });
  const initialTask = lastWorkers(s)[0]!.task;
  s.crew.onMessage(peer(API_ID), incoming("r1", "progress"));
  assert.equal(lastWorkers(s)[0]!.unread, 1);
  const reply = (await s.crew.handle({ op: "send", to: "api", text: "ordinary reply" })) as {
    to: string;
    delivered: boolean;
  };
  assert.deepEqual(
    [reply.to, reply.delivered, s.sent],
    [API_ID, true, [{ to: API_ID, text: "ordinary reply" }]],
  );
  let w = lastWorkers(s)[0]!;
  assert.deepEqual(
    [w.state, w.unread, w.last!.text, w.task],
    ["work", 0, "you: ordinary reply", initialTask],
  );
  assert.deepEqual(
    [eventsOf(s, "feed").at(-1)!.msg.sender, eventsOf(s, "feed").at(-1)!.msg.runId],
    ["lead", w.runId],
  );

  await s.crew.handle({ op: "send", to: "api", text: "begin search", task: "search the codebase" });
  w = lastWorkers(s)[0]!;
  assert.deepEqual(w.task, { text: "search the codebase", at: s.clock.at });
  assert.equal(json(s.dir, "workers.json")[0].task.text, "search the codebase");
});

test("send that the broker does not deliver is an error and records or updates nothing", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "existing task" });
  const before = lastWorkers(s)[0]!.task;
  s.sendResults.push({ delivered: false, reason: "offline", code: "E_OFFLINE" });
  await assert.rejects(
    s.crew.handle({ op: "send", to: "api", text: "x", task: "undelivered task" }),
    /not delivered to api: offline \(E_OFFLINE\)/,
  );
  assert.deepEqual(lastWorkers(s)[0]!.task, before);
  assert.equal(eventsOf(s, "feed").length, 1, "only the spawn task was recorded");
});

test("history pages chronologically with exclusive cursors and never changes inbox or unread state", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  for (let i = 1; i <= 12; i++)
    s.crew.onMessage(peer(API_ID), incoming(`h${String(i).padStart(2, "0")}`, `message ${i}`));
  const workersBefore = readFileSync(join(s.dir, "workers.json"), "utf8");
  const inboxBefore = readFileSync(join(s.dir, "inbox.json"), "utf8");
  const feedBefore = readFileSync(join(s.dir, "feed.jsonl"), "utf8");
  const receiptsBefore = [...s.receipts];
  const eventsBefore = s.events.length;

  const first = (await s.crew.handle({ op: "history", name: "api" })) as {
    runId: string;
    messages: Array<{ id: string }>;
    hasOlder: boolean;
  };
  assert.equal(first.runId, lastWorkers(s)[0]!.runId);
  assert.deepEqual(
    first.messages.map((m) => m.id),
    Array.from({ length: 10 }, (_, i) => `h${String(i + 3).padStart(2, "0")}`),
  );
  assert.equal(first.hasOlder, true);
  const older = (await s.crew.handle({ op: "history", name: "api", before: "h08", limit: 3 })) as {
    messages: Array<{ id: string }>;
    hasOlder: boolean;
  };
  assert.deepEqual(
    older.messages.map((m) => m.id),
    ["h05", "h06", "h07"],
  );
  assert.equal(older.hasOlder, true);
  const oldest = (await s.crew.handle({ op: "history", name: "api", before: "h03", limit: 5 })) as {
    messages: Array<{ id: string }>;
    hasOlder: boolean;
  };
  assert.deepEqual(
    oldest.messages.map((m) => m.id),
    ["h01", "h02"],
  );
  assert.equal(oldest.hasOlder, false);

  assert.deepEqual(
    [
      readFileSync(join(s.dir, "workers.json"), "utf8"),
      readFileSync(join(s.dir, "inbox.json"), "utf8"),
      readFileSync(join(s.dir, "feed.jsonl"), "utf8"),
      s.receipts,
      s.events.length,
    ],
    [workersBefore, inboxBefore, feedBefore, receiptsBefore, eventsBefore],
    "history reads are side-effect free",
  );
});

test("history reads older data beyond the 200-message UI replay cap", async () => {
  const s = setup({ deps: { historyLimit: 500 } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  for (let i = 1; i <= 210; i++)
    s.crew.onMessage(peer(API_ID), incoming(`m${String(i).padStart(3, "0")}`, `message ${i}`));
  s.crew.ready();
  assert.equal(eventsOf(s, "ready")[0]!.feed.length, 200);
  const page = (await s.crew.handle({ op: "history", name: "api", before: "m210", limit: 50 })) as {
    messages: Array<{ id: string }>;
    hasOlder: boolean;
  };
  assert.equal(page.messages.length, 50);
  assert.deepEqual([page.messages[0]!.id, page.messages.at(-1)!.id], ["m160", "m209"]);
  assert.equal(page.hasOlder, true);
});

test("history rejects expired or unknown cursors and a requested run that is not current", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  const oldRunId = lastWorkers(s)[0]!.runId;
  s.crew.onMessage(peer(API_ID), incoming("old", "old message"));
  await s.crew.handle({ op: "stop", name: "api" });
  const spawned = (await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" })) as {
    worker: { runId: string };
  };
  assert.notEqual(spawned.worker.runId, oldRunId, "respawn gets a fresh run identity");
  await assert.rejects(
    s.crew.handle({ op: "history", name: "api", runId: "not-current" }),
    /run.*mismatch|not current/i,
  );
  await assert.rejects(
    s.crew.handle({ op: "history", name: "api", before: "old" }),
    /cursor.*(retained|unknown|history)/i,
  );
  s.crew.onMessage(peer(API_ID), incoming("fresh", "fresh message"));
  s.clock.at += 25 * 60 * 60_000;
  s.crew.prune();
  await assert.rejects(
    s.crew.handle({ op: "history", name: "api", before: "fresh" }),
    /cursor.*(retained|unknown|history)/i,
  );
});

test("history keeps legacy messages and unknown legacy senders until the worker is respawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const legacy = {
    name: "api",
    id: API_ID,
    cwd: "/w",
    model: "m",
    n: 1,
    state: "idle",
    unread: 0,
    startedAt: 1,
    lastAt: 1,
  };
  writeFileSync(join(dir, "workers.json"), JSON.stringify([legacy]));
  writeFileSync(
    join(dir, "feed.jsonl"),
    [
      { id: "legacy-out", at: 2, kind: "out", text: "old task", peer: "api", worker: "api" },
      { id: "legacy-in", at: 3, kind: "report", text: "old reply", peer: "api", worker: "api" },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const s = setup({ dir });
  const old = (await s.crew.handle({ op: "history", name: "api" })) as {
    runId?: string;
    messages: Array<{ id: string; sender?: string }>;
  };
  assert.equal(old.runId, undefined);
  assert.deepEqual(
    old.messages.map((m) => m.id),
    ["legacy-out", "legacy-in"],
  );
  assert.equal(
    old.messages[0]!.sender,
    undefined,
    "do not manufacture lead identity for legacy outgoing messages",
  );
  await s.crew.handle({ op: "stop", name: "api" });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  const current = (await s.crew.handle({ op: "history", name: "api" })) as {
    runId: string;
    messages: Array<{ id: string }>;
  };
  assert.equal(typeof current.runId, "string");
  assert.deepEqual(current.messages, []);
});

test("history retention honors a configured per-run cap and the 24-hour expiry", async () => {
  const s = setup({ deps: { historyLimit: 2 } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  for (let i = 1; i <= 3; i++) s.crew.onMessage(peer(API_ID), incoming(`r${i}`, `message ${i}`));
  s.crew.prune();
  const history = (await s.crew.handle({ op: "history", name: "api" })) as {
    messages: Array<{ id: string }>;
    hasOlder: boolean;
  };
  assert.deepEqual(
    history.messages.map((m) => m.id),
    ["r2", "r3"],
  );
  assert.equal(history.hasOlder, false, "pruned entries are not advertised as older pages");
  s.clock.at += 24 * 60 * 60_000;
  s.crew.prune();
  assert.deepEqual(
    ((await s.crew.handle({ op: "history", name: "api" })) as { messages: unknown[] }).messages,
    [],
  );
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
  assert.equal(eventsOf(s, "feed")[0]!.msg.sender, undefined, "unmanaged sessions have no inferred sender role");
  assert.equal(json(s.dir, "inbox.json").length, 1);
  assert.deepEqual(await s.crew.handle({ op: "ack", id: "m1" }), { acked: "m1" });
  assert.deepEqual(json(s.dir, "inbox.json"), []);
});

test("unread counts what the lead does not have yet: an ack lowers it, never below what still waits", async () => {
  const s = setup({ deps: { idleMs: 60_000 } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w", task: "t" });
  const unread = () => lastWorkers(s)[0]!.unread;
  s.crew.onMessage(peer(API_ID), incoming("p1", "step 1"));
  s.crew.onMessage(peer(API_ID), incoming("p2", "step 2"));
  assert.equal(unread(), 2);
  await s.crew.handle({ op: "ack", id: "p1" });
  assert.equal(unread(), 1, "the lead has p1");
  await s.crew.handle({ op: "ack", id: "p1" });
  assert.equal(unread(), 1, "an ack twice changes nothing");
  await s.crew.handle({ op: "read", name: "api" });
  s.crew.onMessage(peer(API_ID), incoming("p3", "step 3"));
  await s.crew.handle({ op: "ack", id: "p2" });
  assert.equal(unread(), 1, "p3 arrived after the user read the thread and still waits");
  s.clock.at += 5 * 60_000;
  await s.crew.checkIdle();
  assert.ok(json(s.dir, "inbox.json").some((m: any) => m.kind === "idle"), "the quiet alert waits in the inbox");
  await s.crew.handle({ op: "ack", id: "p3" });
  assert.equal(unread(), 0, "the quiet alert still waits and was never counted");
  assert.equal(json(s.dir, "workers.json")[0].unread, 0);
});

test("a record written before 0.5 that counts messages the lead already has is corrected at load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const record = { name: "api", id: API_ID, cwd: "/w", model: "m", n: 1, state: "work", startedAt: 0, lastAt: 0 };
  writeFileSync(join(dir, "workers.json"), JSON.stringify([{ ...record, unread: 3 }, { ...record, name: "web", id: "web-id", n: 2, unread: 2 }]));
  const waits = (id: string) => ({ type: "message", from: { id: "web-id", cwd: "/w", worker: "web" }, id, expectsReply: false, kind: "report", text: "step" });
  writeFileSync(join(dir, "inbox.json"), JSON.stringify([waits("p1"), waits("p2")]));
  const s = setup({ dir });
  s.crew.ready();
  assert.deepEqual(eventsOf(s, "ready")[0]!.workers.map(w => [w.name, w.unread]), [["api", 0], ["web", 2]]);
});

test("a worker spawned without a task stays idle after its ready and raises no quiet alert", async () => {
  const s = setup({ deps: { idleMs: 60_000 } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  s.crew.onMessage(peer(API_ID), incoming("r1", "ready"));
  assert.equal(lastWorkers(s)[0]!.state, "idle");
  s.clock.at += 60 * 60_000;
  await s.crew.checkIdle();
  assert.equal(json(s.dir, "inbox.json").some((m: any) => m.kind === "idle"), false);
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
  assert.deepEqual(json(s.dir, "inbox.json").find((m: any) => m.id === "d1").checks, d1.checks);
  const checkedFeed = readLines<any>(join(s.dir, "feed.jsonl")).find(m => m.id === "d1");
  assert.deepEqual(checkedFeed.checks, { ...d1.checks, at: s.clock.at });
  assert.deepEqual([checkedFeed.runId, checkedFeed.sender], [lastWorkers(s)[0]!.runId, "worker"]);
  assert.ok(eventsOf(s, "feedset").some(e => e.feed.some(m => m.id === "d1" && m.checks?.at === s.clock.at)), "feed update carries checks and identity");
  assert.equal(lastWorkers(s)[0]!.state, "idle");
});

test("a DONE left in the inbox is checked again even when it already has a result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-unit-"));
  const first = setup({ dir });
  await first.crew.handle({ op: "spawn", name: "api", cwd: "/w" });
  const head = "a".repeat(40);
  const outputs = [["rev-parse HEAD", head], ["branch --show-current", "feat/x"], ["status --porcelain", ""], ["worktree list --porcelain", "worktree /w"], ["rev-parse --show-toplevel", "/w"]];
  for (const [args, out] of outputs) first.gitOut.set(args!, out!);
  first.crew.ready();
  first.crew.onMessage(peer(API_ID), incoming("d1", `DONE: shipped\nhead: ${head}\nbranch: feat/x\ntests: none\nrc: 0\nlogs: none`));
  await until(() => eventsOf(first, "message").length === 1, "the first DONE");
  assert.deepEqual(json(dir, "inbox.json")[0].checks, { ok: true, notes: [] });
  assert.deepEqual(readLines<any>(join(dir, "feed.jsonl")).find(m => m.id === "d1").checks, { ok: true, notes: [], at: first.clock.at });

  const second = setup({ dir });
  for (const [args, out] of outputs) second.gitOut.set(args!, out!);
  second.gitOut.set("status --porcelain", " M changed.txt");
  second.crew.ready();
  await until(() => eventsOf(second, "message").length === 1, "the replayed DONE");
  const done = eventsOf(second, "message")[0]!;
  assert.equal(done.id, "d1");
  assert.equal(done.kind, "done");
  if (done.kind !== "done") throw new Error("expected DONE");
  assert.deepEqual(done.checks, { ok: false, notes: ["uncommitted changes in /w: 1 path(s)"] });
  assert.deepEqual(json(dir, "inbox.json")[0].checks, done.checks);
  assert.deepEqual(readLines<any>(join(dir, "feed.jsonl")).find(m => m.id === "d1").checks, { ...done.checks, at: second.clock.at });
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

test("a queued DONE from a previous worker run is explicitly unverified", async () => {
  const s = setup();
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/old" });
  const oldRun = lastWorkers(s)[0]!.runId;
  s.crew.onMessage(peer(API_ID), incoming("old-done", "DONE: old result"));
  await s.crew.handle({ op: "stop", name: "api" });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/new" });
  assert.notEqual(lastWorkers(s)[0]!.runId, oldRun);
  s.crew.ready();
  await until(() => eventsOf(s, "message").length === 1, "old DONE is announced");
  const done = eventsOf(s, "message")[0]!;
  assert.equal(done.kind, "done");
  if (done.kind !== "done") throw new Error("expected DONE");
  assert.equal(done.checks?.ok, false);
  assert.match(done.checks?.notes.join(" ") ?? "", /previous worker run/);
});

test("a send finishing after respawn cannot overwrite the new worker run", async () => {
  let delivered!: () => void;
  const wait = new Promise<{ delivered: boolean; id: string }>(resolve => { delivered = () => resolve({ delivered: true, id: "old-send" }); });
  const s = setup({ deps: { client: { listSessions: async () => [], send: async () => wait, sendMessageReceipt: () => {} } } });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/old", task: "old task" });
  const sending = s.crew.handle({ op: "send", to: "api", text: "old message", task: "old replacement" });
  await s.crew.handle({ op: "stop", name: "api" });
  await s.crew.handle({ op: "spawn", name: "api", cwd: "/new", task: "new task" });
  const newRun = lastWorkers(s)[0]!.runId;
  delivered();
  await sending;
  assert.equal(json(s.dir, "workers.json")[0].runId, newRun);
  assert.equal(json(s.dir, "workers.json")[0].task.text, "new task");
});
