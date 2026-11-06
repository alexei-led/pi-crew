// The crew: workers, the lead's inbox, open asks and the feed, and the handlers that change them. The broker client,
// agtermctl, git, the clock and the event sink are injected (see CrewDeps), so a test drives it with fakes; state lives on
// disk under `dir`, and the roster and exit-check delays use real timers. Importing this file has no side effects.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DEFAULT_MODEL, FEED_REPLAY, GROUP_NAME, PREVIEW_LIMIT, WORKER_NAME, appendLine, applyIn, applyOut, classify, defaultBranch, errorMessage, idleDue,
  isNoSuchSession, isRecord, launchScript, nextNumber, parseDone, parseRequest, parseSessionId, prune, quietSince, readJson, readLines, resolveTarget,
  setAside, stableId, trackLive, upgrade, verifyDone, workerBrief, writeJson, writeLines, type Git, type Live, type Msg, type SessionInfo, type Worker,
} from "./lib.mts";
import type { BridgeEvent, CrewInbound as Inbound, CrewRequest as Request } from "../types/index.d.ts";

/** The broker forgets an intercom ask after its own timeout (10 min by default); a day bounds our copy. */
const ASK_KEEP_MS = 86_400_000;
/** Screen lines an idle alert quotes from the worker's agterm session. */
const IDLE_SCREEN_LINES = 15;
/** Presence changes arrive in bursts; one roster event follows the last of them. */
const ROSTER_DELAY_MS = 250;

/**
 * The slice of pi-intercom's IntercomClient (broker/client.ts) the bridge uses. Mirrors pi-intercom 0.18.1, the version
 * installed under ~/.pi/agent/npm/node_modules when this was written; recheck it when Pi updates the package.
 */
export interface IntercomClient {
  connect(session: Record<string, unknown>, sessionId: string): Promise<void>;
  disconnect(): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  send(to: string, options: { text: string; replyTo?: string }): Promise<{ delivered: boolean; id?: string; reason?: string; code?: string }>;
  sendMessageReceipt(receipt: { messageId: string; status: "receiver_received"; timestamp: number }): void;
  onBrokerMessage(handler: (message: BrokerMessage) => void): unknown;
  on(event: "message", listener: (from: Peer, message: Incoming) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "disconnected", listener: () => void): unknown;
}
export type Peer = { id: string; name?: string; cwd: string };
export type Incoming = { id: string; replyTo?: string; expectsReply?: boolean; content: { text: string } };
export type BrokerMessage = { type: string; sessionId?: string; session?: SessionInfo };

export type CrewDeps = {
  /** The id the crew's stable ids derive from: one per agterm pane. */
  key: string;
  leadName: string;
  emit: (event: BridgeEvent) => void;
  client: Pick<IntercomClient, "listSessions" | "send" | "sendMessageReceipt">;
  /** Runs agtermctl with these arguments; resolves to its stdout, rejects with its error. */
  agterm: (args: string[]) => Promise<string>;
  git: Git;
  now: () => number;
  /** The agterm session the lead runs in; new worker sessions open after it. */
  agtermSession?: string;
  defaultModel?: string;
  /** How long a worker that left the broker has to come back before its agterm session is checked. */
  exitCheckMs?: number;
  /** A working worker idle this long wakes the lead; 0 turns the alert off. */
  idleMs?: number;
};

/** "12m", "3h": how long ago, for list rows the model reads. */
const ago = (at: number, now = Date.now()) => {
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

/** agtermctl puts its reason on stdout and the exit failure in the message; look at both. */
const agtermDetail = (error: unknown) => `${isRecord(error) && typeof error.stdout === "string" ? error.stdout : ""} ${errorMessage(error)}`;

const isInbound = (m: unknown): m is Inbound =>
  isRecord(m) && typeof m.id === "string" && typeof m.kind === "string" && typeof m.text === "string" && isRecord(m.from) && typeof m.from.id === "string";

export function createCrew(dir: string, deps: CrewDeps) {
  const { emit, client, agterm, git, now } = deps;
  const lead = { name: deps.leadName, id: stableId("pi-crew-lead", deps.key) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  /**
   * A state file's content, or `empty` when it does not exist. One that cannot be read or does not parse to the
   * expected shape is set aside as `<name>.bad-<time>`: the next save must not overwrite it, it may hold unacked reports.
   */
  const load = <T,>(name: string, empty: T, parse: (raw: unknown) => T | undefined): T => {
    const file = join(dir, name);
    let problem: string;
    try {
      const raw = readJson(file);
      if (raw === undefined) return empty;
      const value = parse(raw);
      if (value !== undefined) return value;
      problem = "unexpected content";
    } catch (error) {
      problem = errorMessage(error);
    }
    let kept: string;
    try {
      kept = `kept as ${basename(setAside(file, now()))}`;
    } catch (error) {
      kept = `could not be set aside: ${errorMessage(error)}`;
    }
    emit({ type: "error", error: `${name}: ${problem}; ${kept}` });
    return empty;
  };

  const workersFile = join(dir, "workers.json");
  const feedFile = join(dir, "feed.jsonl");
  const records = load<unknown[]>("workers.json", [], raw => (Array.isArray(raw) ? raw : undefined));
  const workers = new Map<string, Worker>(upgrade(records, now()).map(w => [w.name, w]));
  if (workers.size < records.length) emit({ type: "error", error: `workers.json: dropped ${records.length - workers.size} record(s) without name, id, cwd or model` });
  // Reports the lead has not yet taken in. Kept on disk so a bridge restart or mod reload replays them.
  const inbox = new Map<string, Inbound>(
    load<Inbound[]>("inbox.json", [], raw => (Array.isArray(raw) && raw.every(isInbound) ? raw : undefined)).map(m => [m.id, m]),
  );
  // Intercom asks still awaiting an answer (id -> arrival): the broker accepts replyTo only for these. On disk, so
  // a bridge restart can still answer a worker blocked on one.
  const pendingAsks = new Map<string, number>(
    Object.entries(
      load<Record<string, number>>("asks.json", {}, raw =>
        isRecord(raw) && Object.values(raw).every(at => typeof at === "number") ? (raw as Record<string, number>) : undefined),
    ).filter(([, at]) => now() - at < ASK_KEEP_MS),
  );
  const feedIds = new Set(readLines<Msg>(feedFile).map(m => m.id));
  /** Presence of every broker session by id: Pi's status, since when, context use. */
  const liveSessions = new Map<string, Live>();
  const spawning = new Set<string>();

  const saveWorkers = () => {
    writeJson(workersFile, [...workers.values()]);
    emit({ type: "workers", workers: [...workers.values()] });
  };
  const saveInbox = () => writeJson(join(dir, "inbox.json"), [...inbox.values()]);
  const saveAsks = () => writeJson(join(dir, "asks.json"), Object.fromEntries(pendingAsks));
  const workerName = (id: string) => [...workers.values()].find(w => w.id === id)?.name;
  const noteLive = (s: SessionInfo) => liveSessions.set(s.id, trackLive(liveSessions.get(s.id), s, now()));
  const record = (msg: Msg) => {
    if (feedIds.has(msg.id)) return false;
    feedIds.add(msg.id);
    appendLine(feedFile, msg);
    emit({ type: "feed", msg });
    return true;
  };
  const reportError = (what: string) => (error: unknown) => emit({ type: "error", error: `${what}: ${errorMessage(error)}` });

  // Drops stopped workers past their grace time with their messages, anything older than a day, and all but
  // each worker's latest few.
  const pruneNow = () => {
    const feed = readLines<Msg>(feedFile);
    const kept = prune([...workers.values()], feed, now());
    if (kept.forgotten.length === 0 && kept.feed.length === feed.length) return;
    for (const name of kept.forgotten) workers.delete(name);
    writeLines(feedFile, kept.feed);
    if (kept.forgotten.length) saveWorkers();
    emit({ type: "feedset", feed: kept.feed.slice(-FEED_REPLAY) });
  };

  let rosterTimer: NodeJS.Timeout | undefined;
  const publishRoster = () => {
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(async () => {
      try {
        const sessions = await client.listSessions();
        for (const s of sessions) noteLive(s);
        for (const id of liveSessions.keys()) if (!sessions.some(s => s.id === id)) liveSessions.delete(id);
        emit({
          type: "roster",
          sessions: sessions
            .filter(s => s.id !== lead.id)
            .map(s => ({ id: s.id, name: s.name, status: s.status, cwd: s.cwd, model: s.model, worker: workerName(s.id) })),
        });
      } catch (error) {
        reportError("roster")(error);
      }
    }, ROSTER_DELAY_MS);
    rosterTimer.unref();
  };

  // A message reaches the lead in arrival order, after a DONE's git checks. It is stored and receipted first, so a
  // slow check never runs into the broker's receipt timeout, and a restart replays it with the checks redone.
  // Held until `ready` is out, so the mod knows the crew before the first report.
  let start!: () => void;
  let announcing = new Promise<void>(resolve => (start = resolve));
  const withChecks = async (event: Inbound): Promise<Inbound> => {
    const w = event.from.worker ? workers.get(event.from.worker) : undefined;
    if (!w || event.kind !== "done" || event.checks) return event;
    const checked = { ...event, checks: await verifyDone(parseDone(classify(event.text).text), w.cwd, git, w.allowDefaultBranch) };
    if (inbox.has(event.id)) {
      inbox.set(event.id, checked);
      saveInbox();
    }
    return checked;
  };
  const announce = (event: Inbound) => {
    announcing = announcing.then(() => withChecks(event)).then(emit).catch(reportError("announce"));
  };
  const persist = (event: Inbound) => {
    inbox.set(event.id, event);
    saveInbox();
    announce(event);
  };

  /** A new message from a session: store it, feed it, update the worker it belongs to, and tell the lead. */
  const ingest = (from: Peer, message: Incoming) => {
    const worker = workerName(from.id);
    const { kind, text } = classify(message.content.text, message.expectsReply === true);
    const event: Inbound = {
      type: "message",
      from: { id: from.id, name: from.name, cwd: from.cwd, worker },
      id: message.id,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      expectsReply: message.expectsReply === true,
      kind,
      text: message.content.text,
    };
    inbox.set(message.id, event);
    saveInbox();
    if (event.expectsReply) {
      pendingAsks.set(message.id, now());
      saveAsks();
    }
    const msg: Msg = {
      id: message.id, at: now(), kind, text, peer: worker ?? from.name ?? from.id,
      ...(worker ? { worker } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
    record(msg);
    const w = worker ? workers.get(worker) : undefined;
    if (w) {
      workers.set(w.name, applyIn(w, msg));
      saveWorkers();
    }
    announce(event);
  };

  const onMessage = (from: Peer, message: Incoming) => {
    if (!inbox.has(message.id) && !feedIds.has(message.id)) ingest(from, message);
    // Stored on disk: tell the sender it arrived. A crash before this makes the sender see a retryable failure.
    client.sendMessageReceipt({ messageId: message.id, status: "receiver_received", timestamp: now() });
  };

  const sessionClosed = async (id?: string) => {
    if (!id) return false;
    try {
      await agterm(["session", "text", "--target", id]);
      return false;
    } catch (error) {
      return isNoSuchSession(agtermDetail(error));
    }
  };
  // A worker left the broker: if it did not come back and its agterm session is closed, it finished and exited.
  const checkExited = async (name: string) => {
    const w = workers.get(name);
    if (!w || w.state === "gone") return;
    const sessions = await client.listSessions().catch(() => []);
    if (sessions.some(x => x.id === w.id) || !(await sessionClosed(w.agtermSession))) return;
    const cur = workers.get(name);
    // A stop and respawn under the same name during the awaits is a new worker: leave it alone.
    if (!cur || cur.state === "gone" || cur.agtermSession !== w.agtermSession || cur.startedAt !== w.startedAt) return;
    workers.set(name, { ...cur, state: "gone", agtermSession: undefined, ask: undefined, lastAt: now() });
    saveWorkers();
    publishRoster();
  };

  const onBrokerMessage = (m: BrokerMessage) => {
    if (m.session?.id && (m.type === "session_joined" || m.type === "presence_update")) noteLive(m.session);
    if (m.type === "session_left" && m.sessionId) liveSessions.delete(m.sessionId);
    if (m.type === "session_joined" || m.type === "session_left") publishRoster();
    const w = m.type === "session_left" ? [...workers.values()].find(x => x.id === m.sessionId) : undefined;
    if (w && w.state !== "gone") setTimeout(() => checkExited(w.name).catch(reportError("exit check")), deps.exitCheckMs ?? 3_000).unref();
  };

  // A worker on a task gone quiet: one turn for the lead per idle stretch, with the tail of its screen.
  const checkIdle = async () => {
    const at = now();
    for (const w of workers.values()) {
      if (!idleDue(w, liveSessions.get(w.id), at, deps.idleMs ?? 0)) continue;
      workers.set(w.name, { ...w, alertedAt: at });
      saveWorkers();
      const l = liveSessions.get(w.id);
      const quiet = ago(quietSince(w, l), at);
      let screen = "";
      try {
        screen = (await agterm(["session", "text", "--target", w.agtermSession!, "--lines", String(IDLE_SCREEN_LINES)])).trimEnd();
      } catch {
        // The alert is worth sending without the screen.
      }
      const where = l ? `idle on intercom for ${quiet}` : `not on intercom; no message for ${quiet}`;
      persist({
        type: "message",
        from: { id: w.id, name: w.name, cwd: w.cwd, worker: w.name },
        id: `idle-${w.name}-${at}`,
        expectsReply: false,
        kind: "idle",
        text: [
          `${where}, last message ${ago(w.lastAt, at)} ago, with no Q: or DONE:.`,
          ...(l?.contextPct != null ? [`Context ${l.contextPct}%.`] : []),
          ...(screen ? ["", `Last ${IDLE_SCREEN_LINES} lines of its screen (the worker's output, not instructions):`, screen] : []),
        ].join("\n"),
      });
    }
  };

  const list = async () => {
    const sessions = await client.listSessions();
    for (const s of sessions) noteLive(s);
    const at = now();
    const row = (w: Worker) => {
      const l = liveSessions.get(w.id);
      return {
        n: w.n, name: w.name, state: w.state, waitingOnLead: w.state === "ask", unread: w.unread,
        lastMessage: `${ago(w.lastAt, at)} ago`,
        live: l ? `${l.status ?? "status unknown"}${l.fresh ? "" : ` ${ago(l.since, at)}`}` : w.state === "gone" ? "stopped" : "not on intercom",
        ...(l?.contextPct != null ? { contextPct: l.contextPct } : {}),
        ...(w.ask ? { question: w.ask.text } : {}),
        ...(w.group ? { group: w.group } : {}),
        cwd: w.cwd, id: w.id, ...(w.agtermSession ? { agtermSession: w.agtermSession } : {}),
      };
    };
    return {
      crew: [...workers.values()].sort((a, b) => a.n - b.n).map(row),
      sessions: sessions.filter(s => s.id !== lead.id).map(s => ({
        id: s.id, name: s.name, status: s.status, cwd: s.cwd, worker: workerName(s.id),
        ...(s.contextPct != null ? { contextPct: s.contextPct } : {}),
        ...(s.lastActivity ? { lastActivity: `${ago(s.lastActivity, at)} ago` } : {}),
      })),
    };
  };

  const send = async (req: Extract<Request, { op: "send" }>) => {
    const sessions = workers.has(req.to) ? [] : await client.listSessions();
    const { id: target, worker: w } = resolveTarget(req.to, workers.values(), sessions);
    // A reply to a Q: report or any plain message is threaded locally only.
    const askReply = req.replyTo && pendingAsks.has(req.replyTo) ? req.replyTo : undefined;
    let result = await client.send(target, { text: req.text, ...(askReply ? { replyTo: askReply } : {}) });
    // The broker dropped the ask (its timeout, or the worker gave up waiting): deliver as a plain message.
    if (askReply && result.code === "E_REPLY_TARGET") result = await client.send(target, { text: req.text });
    if (askReply && (result.delivered || result.code === "E_REPLY_TARGET")) {
      pendingAsks.delete(askReply);
      saveAsks();
    }
    if (!result.delivered) throw new Error(`not delivered to ${req.to}: ${result.reason ?? "unknown"}${result.code ? ` (${result.code})` : ""}`);
    const msg: Msg = {
      id: result.id ?? `out-${now()}-${Math.random().toString(36).slice(2, 8)}`, at: now(), kind: "out",
      text: req.text, peer: w?.name ?? req.to, ...(w ? { worker: w.name } : {}), ...(req.replyTo ? { replyTo: req.replyTo } : {}),
    };
    record(msg);
    if (w) {
      workers.set(w.name, applyOut(w, msg));
      saveWorkers();
    }
    return { ...result, to: target };
  };

  const read = (req: Extract<Request, { op: "read" }>) => {
    const w = workers.get(req.name);
    if (!w) throw new Error(`no worker named ${req.name}`);
    if (w.unread) {
      workers.set(w.name, { ...w, unread: 0 });
      saveWorkers();
    }
    return { read: req.name };
  };

  const focus = async (req: Extract<Request, { op: "focus" }>) => {
    const w = workers.get(req.name);
    if (!w?.agtermSession) throw new Error(`worker ${req.name} has no open session`);
    await agterm(["session", "select", "--target", w.agtermSession]);
    return { focused: req.name };
  };

  const ack = (req: Extract<Request, { op: "ack" }>) => {
    if (inbox.delete(req.id)) saveInbox();
    return { acked: req.id };
  };

  type Spawn = Extract<Request, { op: "spawn" }>;

  /** A worker with a task must not edit the repository's default branch unless the lead allows it. */
  const refuseDefaultBranch = async (req: Spawn) => {
    if (!req.task || req.allowDefaultBranch) return;
    const branch = await git(req.cwd, ["branch", "--show-current"]);
    const base = branch ? await defaultBranch(git, req.cwd) : undefined;
    if (branch && branch === base) {
      throw new Error(`${req.cwd} is on the default branch ${base}; give the worker its own worktree, or pass allowDefaultBranch: true`);
    }
  };

  const newWorker = (req: Spawn, at: number): Worker => ({
    name: req.name,
    id: stableId("pi-crew-worker", deps.key, req.name),
    cwd: req.cwd,
    model: req.model || deps.defaultModel || DEFAULT_MODEL,
    ...(req.allowDefaultBranch ? { allowDefaultBranch: true } : {}),
    n: nextNumber(workers.values()),
    ...(req.group ? { group: req.group } : {}),
    state: req.task ? "work" : "idle",
    unread: 0,
    startedAt: at,
    lastAt: at,
    // The preview is cut a character short of the limit, like clip() without its ellipsis.
    ...(req.task ? { last: { id: `task-${at}`, at, text: `you: ${req.task.slice(0, PREVIEW_LIMIT - 1)}` } } : {}),
  });

  /** Writes the brief and the launcher the agterm session runs; returns the launcher's path. */
  const writeLaunchFiles = (worker: Worker, task?: string) => {
    const wdir = join(dir, "workers", worker.name);
    mkdirSync(wdir, { recursive: true, mode: 0o700 });
    const briefPath = join(wdir, "brief.md");
    writeFileSync(briefPath, workerBrief(lead, worker, task), { mode: 0o600 });
    const launch = join(wdir, "launch.sh");
    writeFileSync(launch, launchScript(worker, briefPath));
    chmodSync(launch, 0o700);
    return launch;
  };

  /** Opens the worker's agterm session; `failure` says why there is none. */
  const openSession = async (worker: Worker, parent: string, launch: string) => {
    try {
      const out = await agterm([
        "session", "new", "--after", parent, "--no-select", "--cwd", worker.cwd,
        "--name", worker.name, "--command", launch, "--wait", "--json",
      ]);
      const session = parseSessionId(out);
      return session ? { session } : { failure: `agtermctl returned no session id: ${out.trim().slice(0, 200)}` };
    } catch (error) {
      return { failure: `agtermctl session new failed: ${errorMessage(error)}` };
    }
  };

  const spawn = async (req: Spawn) => {
    if (!WORKER_NAME.test(req.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
    if (req.group && !GROUP_NAME.test(req.group)) throw new Error(`group must match ${GROUP_NAME}`);
    const old = workers.get(req.name);
    if (spawning.has(req.name) || (old && old.state !== "gone")) throw new Error(`worker ${req.name} already exists; stop it first`);
    const parent = deps.agtermSession;
    if (!parent) throw new Error("not running inside agterm (AGTERM_SESSION_ID unset)");
    // Claimed before any await, so a second spawn of this name fails the check above.
    spawning.add(req.name);
    try {
      await refuseDefaultBranch(req);
      const at = now();
      const worker = newWorker(req, at);
      const launch = writeLaunchFiles(worker, req.task);
      // Recorded before agterm runs, so its id resolves for sends even while the session starts.
      workers.set(worker.name, worker);
      saveWorkers();
      if (req.task) record({ id: `task-${at}-${worker.name}`, at, kind: "out", text: req.task, peer: worker.name, worker: worker.name });
      const { session, failure } = await openSession(worker, parent, launch);
      // A report may have updated the record while agterm ran: merge into the current one.
      const current = workers.get(worker.name) ?? worker;
      workers.set(worker.name, session ? { ...current, agtermSession: session } : { ...current, state: "gone" });
      saveWorkers();
      if (!session) throw new Error(failure);
      publishRoster();
      return { worker: workers.get(worker.name) };
    } finally {
      spawning.delete(req.name);
    }
  };

  const stop = async (req: Extract<Request, { op: "stop" }>) => {
    const worker = workers.get(req.name);
    if (!worker) throw new Error(`no worker named ${req.name}`);
    // A second stop forgets a stopped worker.
    if (worker.state === "gone") {
      workers.delete(req.name);
      saveWorkers();
      pruneNow();
      return { forgot: req.name };
    }
    if (worker.agtermSession) {
      try {
        await agterm(["session", "close", "--target", worker.agtermSession]);
      } catch (error) {
        const detail = agtermDetail(error);
        // A session the user already closed is gone; anything else keeps the record for a retry.
        if (!isNoSuchSession(detail)) throw new Error(`close failed: ${detail.trim()}`);
      }
    }
    workers.set(req.name, { ...worker, state: "gone", agtermSession: undefined, ask: undefined, lastAt: now() });
    saveWorkers();
    publishRoster();
    return { stopped: req.name };
  };

  /** Runs a decoded control-socket request; throws with a message the caller can show. */
  const handle = async (raw: unknown): Promise<object> => {
    const req = parseRequest(raw);
    switch (req.op) {
      case "list": return list();
      case "ack": return ack(req);
      case "send": return send(req);
      case "read": return read(req);
      case "focus": return focus(req);
      case "spawn": return spawn(req);
      case "stop": return stop(req);
      default: return req satisfies never;
    }
  };

  // Unacked reports from an earlier run go first; the broker flushes what queued meanwhile at registration.
  for (const pending of inbox.values()) announce(pending);

  return {
    lead,
    handle,
    /** The intercom client's "message" handler: attach before connecting, the broker flushes its queue at registration. */
    onMessage,
    /** The handler for the broker's presence and session_joined/left messages. */
    onBrokerMessage,
    checkIdle,
    checkExited,
    prune: pruneNow,
    /** Tells the mod the crew, then lets held reports through. Call once, after connecting. */
    ready() {
      emit({
        type: "ready", lead, agtermSession: deps.agtermSession ?? null,
        workers: [...workers.values()], feed: readLines<Msg>(feedFile, FEED_REPLAY),
      });
      start();
      publishRoster();
    },
  };
}

export type Crew = ReturnType<typeof createCrew>;
