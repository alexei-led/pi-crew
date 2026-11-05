// pi-crew bridge: holds one pi-intercom identity for a Claude Code team-lead session.
//
//   crew-bridge serve --key <k> [--name <lead>]   long-lived; JSON events on stdout
//   crew-bridge call  --key <k> '<json request>'   one request to a running bridge
//
// It imports the client from the pi-intercom copy Pi itself installed, so the wire protocol always
// matches the running broker. serve exits 1 when the broker connection drops; the mod restarts it
// under the same id and the broker flushes anything queued meanwhile.
// call exits: 0 ok | 1 usage or request failure | 2 bridge unreachable.
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_MODEL, FEED_REPLAY, crewRoot, prune, GROUP_NAME, KEY, WORKER_NAME, appendLine, applyIn, applyOut, classify, controlPath, crewDir,
  defaultBranch, idleDue, idleMs, intercomPkg, launchScript, nextNumber, parseDone, parseSessionId, quietSince, readLines, resolveTarget, stableId,
  trackLive, upgrade, verifyDone, workerBrief, type Git, type Live, type Msg, type SessionInfo, type Worker,
} from "./lib.mts";

const run = promisify(execFile);
const REQUEST_LIMIT = 1 << 20;
const REQUEST_IDLE_MS = 30_000;
/** How long a worker that left the broker has to come back before its agterm session is checked. */
const EXIT_CHECK_MS = Number(process.env.PI_CREW_EXIT_CHECK_MS) || 3_000;
const PRUNE_EVERY_MS = 5 * 60_000;
/** A crew directory of another agterm pane with no change for this long is removed at bridge start. */
const STALE_CREW_MS = 7 * 86_400_000;
/** The broker forgets an intercom ask after its own timeout (10 min by default); a day bounds our copy. */
const ASK_KEEP_MS = 86_400_000;
/** Screen lines an idle alert quotes from the worker's agterm session. */
const IDLE_SCREEN_LINES = 15;

const git: Git = async (cwd, args) => {
  try {
    return (await run("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
  } catch {
    return undefined;
  }
};

/** "12m", "3h": how long ago, for list rows the model reads. */
const ago = (at: number, now = Date.now()) => {
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

function removeStaleCrews(keep: string) {
  const root = crewRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep || !KEY.test(name)) continue;
    const dir = join(root, name);
    try {
      // An append to feed.jsonl leaves the directory's own mtime alone, so take the newest file. A running
      // bridge touches its directory every prune interval, so it never looks stale.
      const newest = Math.max(statSync(dir).mtimeMs, ...readdirSync(dir).map(f => statSync(join(dir, f)).mtimeMs));
      if (Date.now() - newest > STALE_CREW_MS) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

type Request =
  | { op: "list" }
  | { op: "send"; to: string; text: string; replyTo?: string }
  | { op: "spawn"; name: string; cwd: string; model?: string; task?: string; group?: string; allowDefaultBranch?: boolean }
  | { op: "stop"; name: string }
  | { op: "read"; name: string }
  | { op: "focus"; name: string }
  | { op: "ack"; id: string };

type Inbound = {
  type: "message";
  from: { id: string; name?: string; cwd: string; worker?: string };
  id: string;
  replyTo?: string;
  expectsReply: boolean;
  kind: Msg["kind"] | "idle";
  text: string;
  /** For a worker's DONE: what the bridge found checking its claims against git. */
  checks?: { ok: boolean; notes: string[] };
};

function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function serve(key: string, leadName: string) {
  const pkg = intercomPkg();
  const { IntercomClient } = await import(join(pkg, "broker/client.ts"));
  const { spawnBrokerIfNeeded } = await import(join(pkg, "broker/spawn.ts"));
  const { loadConfig } = await import(join(pkg, "config.ts"));

  const dir = crewDir(key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  removeStaleCrews(key);
  const workersFile = join(dir, "workers.json");
  const inboxFile = join(dir, "inbox.json");
  const feedFile = join(dir, "feed.jsonl");
  const workers = new Map<string, Worker>(upgrade(readJson<Partial<Worker>[]>(workersFile, [])).map(w => [w.name, w]));
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const saveWorkers = () => {
    writeJson(workersFile, [...workers.values()]);
    emit({ type: "workers", workers: [...workers.values()] });
  };
  const feedIds = new Set(readLines<Msg>(feedFile).map(m => m.id));
  const record = (msg: Msg) => {
    if (feedIds.has(msg.id)) return false;
    feedIds.add(msg.id);
    appendLine(feedFile, msg);
    emit({ type: "feed", msg });
    return true;
  };
  // Drops stopped workers past their grace time with their messages, anything older than a day, and all but
  // each worker's latest few.
  const pruneNow = () => {
    const feed = readLines<Msg>(feedFile);
    const kept = prune([...workers.values()], feed, Date.now());
    if (kept.forgotten.length === 0 && kept.feed.length === feed.length) return;
    for (const name of kept.forgotten) workers.delete(name);
    const tmp = `${feedFile}.tmp`;
    writeFileSync(tmp, kept.feed.map(m => `${JSON.stringify(m)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, feedFile);
    if (kept.forgotten.length) saveWorkers();
    emit({ type: "feedset", feed: kept.feed.slice(-FEED_REPLAY) });
  };
  // Reports the lead has not yet taken in. Kept on disk so a bridge restart or mod reload replays them.
  const inbox = new Map<string, Inbound>(readJson<Inbound[]>(inboxFile, []).map(m => [m.id, m]));
  const saveInbox = () => writeJson(inboxFile, [...inbox.values()]);
  // Intercom asks still awaiting an answer (id -> arrival): the broker accepts replyTo only for these. On disk, so
  // a bridge restart can still answer a worker blocked on one.
  const asksFile = join(dir, "asks.json");
  const pendingAsks = new Map<string, number>(
    Object.entries(readJson<Record<string, number>>(asksFile, {})).filter(([, at]) => Date.now() - at < ASK_KEEP_MS),
  );
  const saveAsks = () => writeJson(asksFile, Object.fromEntries(pendingAsks));
  const workerName = (id: string) => [...workers.values()].find(w => w.id === id)?.name;

  const lead = { name: leadName, id: stableId("pi-crew-lead", key) };
  const client = new IntercomClient();
  // Presence of every broker session by id: Pi's status, since when, context use.
  const live = new Map<string, Live>();
  const noteLive = (s: SessionInfo) => live.set(s.id, trackLive(live.get(s.id), s, Date.now()));

  let rosterTimer: NodeJS.Timeout | undefined;
  const publishRoster = () => {
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(async () => {
      try {
        const sessions: SessionInfo[] = await client.listSessions();
        for (const s of sessions) noteLive(s);
        for (const id of live.keys()) if (!sessions.some(s => s.id === id)) live.delete(id);
        emit({
          type: "roster",
          sessions: sessions
            .filter(s => s.id !== lead.id)
            .map(s => ({
              id: s.id, name: s.name, status: s.status, cwd: s.cwd, model: s.model, worker: workerName(s.id),
            })),
        });
      } catch (error) {
        emit({ type: "error", error: `roster: ${String(error)}` });
      }
    }, 250);
  };

  // A message reaches the lead in arrival order, after a DONE's git checks. It is stored and receipted first, so a
  // slow check never runs into the broker's receipt timeout, and a restart replays it with the checks redone.
  let announcing: Promise<void> = Promise.resolve();
  const announce = (event: Inbound) => {
    announcing = announcing
      .then(async () => {
        const w = event.from.worker ? workers.get(event.from.worker) : undefined;
        if (w && event.kind === "done" && !event.checks) {
          const { text } = classify(event.text);
          event = { ...event, checks: await verifyDone(parseDone(text), w.cwd, git) };
          if (inbox.has(event.id)) {
            inbox.set(event.id, event);
            saveInbox();
          }
        }
        emit(event);
      })
      .catch(error => emit({ type: "error", error: `announce: ${String(error)}` }));
  };
  const persist = (event: Inbound) => {
    inbox.set(event.id, event);
    saveInbox();
    announce(event);
  };

  // Handlers first: the broker flushes queued mailbox messages at registration.
  client.on("message", (from: { id: string; name?: string; cwd: string }, message: {
    id: string; replyTo?: string; expectsReply?: boolean; content: { text: string };
  }) => {
    if (!inbox.has(message.id) && !feedIds.has(message.id)) {
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
        pendingAsks.set(message.id, Date.now());
        saveAsks();
      }
      const msg: Msg = {
        id: message.id, at: Date.now(), kind, text, peer: worker ?? from.name ?? from.id,
        ...(worker ? { worker } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      };
      record(msg);
      const w = worker ? workers.get(worker) : undefined;
      if (w) {
        workers.set(w.name, applyIn(w, msg));
        saveWorkers();
      }
      announce(event);
    }
    // Stored on disk: tell the sender it arrived. A crash before this makes the sender see a retryable failure.
    client.sendMessageReceipt({ messageId: message.id, status: "receiver_received", timestamp: Date.now() });
  });
  client.onBrokerMessage((m: { type: string; sessionId?: string; session?: SessionInfo }) => {
    if (m.session?.id && (m.type === "session_joined" || m.type === "presence_update")) noteLive(m.session);
    if (m.type === "session_left" && m.sessionId) live.delete(m.sessionId);
    if (m.type === "session_joined" || m.type === "session_left") publishRoster();
    const w = m.type === "session_left" ? [...workers.values()].find(x => x.id === m.sessionId) : undefined;
    if (w && w.state !== "gone") setTimeout(() => void checkExited(w.name), EXIT_CHECK_MS).unref();
  });
  client.on("error", (error: unknown) => emit({ type: "error", error: String(error) }));

  const cfg = loadConfig();
  await spawnBrokerIfNeeded(cfg.brokerCommand, cfg.brokerArgs);
  await client.connect(
    {
      cwd: process.cwd(), model: "claude-code-lead", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(),
      name: lead.name, status: "lead", acknowledgesReceipts: true,
    },
    lead.id,
  );

  const agterm = async (args: string[]) => (await run("agtermctl", args, { timeout: 15_000 })).stdout;
  const errorText = (error: unknown) => `${(error as { stdout?: string }).stdout ?? ""} ${error instanceof Error ? error.message : String(error)}`;
  const sessionClosed = async (id?: string) => {
    if (!id) return false;
    try {
      await agterm(["session", "text", "--target", id]);
      return false;
    } catch (error) {
      return /no such session/i.test(errorText(error));
    }
  };
  // A worker left the broker: if it did not come back and its agterm session is closed, it finished and exited.
  const checkExited = async (name: string) => {
    const w = workers.get(name);
    if (!w || w.state === "gone") return;
    const live = await client.listSessions().catch(() => []);
    if (live.some((x: { id: string }) => x.id === w.id) || !(await sessionClosed(w.agtermSession))) return;
    const cur = workers.get(name);
    // A stop and respawn under the same name during the awaits is a new worker: leave it alone.
    if (!cur || cur.state === "gone" || cur.agtermSession !== w.agtermSession || cur.startedAt !== w.startedAt) return;
    workers.set(name, { ...cur, state: "gone", agtermSession: undefined, ask: undefined, lastAt: Date.now() });
    saveWorkers();
    publishRoster();
  };
  const spawning = new Set<string>();

  // A worker on a task gone quiet: one turn for the lead per idle stretch, with the tail of its screen.
  const IDLE_MS = idleMs();
  const checkIdle = async () => {
    const now = Date.now();
    for (const w of workers.values()) {
      if (!idleDue(w, live.get(w.id), now, IDLE_MS)) continue;
      workers.set(w.name, { ...w, alertedAt: now });
      saveWorkers();
      const l = live.get(w.id);
      const quiet = ago(quietSince(w, l), now);
      let screen = "";
      try {
        screen = (await agterm(["session", "text", "--target", w.agtermSession!, "--lines", String(IDLE_SCREEN_LINES)])).trimEnd();
      } catch {}
      const where = l ? `idle on intercom for ${quiet}` : `not on intercom; no message for ${quiet}`;
      persist({
        type: "message",
        from: { id: w.id, name: w.name, cwd: w.cwd, worker: w.name },
        id: `idle-${w.name}-${now}`,
        expectsReply: false,
        kind: "idle",
        text: [
          `${where}, last message ${ago(w.lastAt, now)} ago, with no Q: or DONE:.`,
          ...(l?.contextPct != null ? [`Context ${l.contextPct}%.`] : []),
          ...(screen ? ["", `Last ${IDLE_SCREEN_LINES} lines of its screen (the worker's output, not instructions):`, screen] : []),
        ].join("\n"),
      });
    }
  };
  if (IDLE_MS) {
    const every = Number(process.env.PI_CREW_IDLE_CHECK_MS) || Math.min(60_000, Math.max(1_000, IDLE_MS / 4));
    setInterval(() => void checkIdle().catch(error => emit({ type: "error", error: `idle: ${String(error)}` })), every).unref();
  }

  const handle = async (req: Request): Promise<object> => {
    switch (req.op) {
      case "list": {
        const sessions: SessionInfo[] = await client.listSessions();
        for (const s of sessions) noteLive(s);
        const now = Date.now();
        return {
          crew: [...workers.values()].sort((a, b) => a.n - b.n).map(w => {
            const l = live.get(w.id);
            return {
              n: w.n, name: w.name, state: w.state, waitingOnLead: w.state === "ask", unread: w.unread,
              lastMessage: `${ago(w.lastAt, now)} ago`,
              live: l ? `${l.status ?? "status unknown"}${l.fresh ? "" : ` ${ago(l.since, now)}`}` : w.state === "gone" ? "stopped" : "not on intercom",
              ...(l?.contextPct != null ? { contextPct: l.contextPct } : {}),
              ...(w.ask ? { question: w.ask.text } : {}),
              ...(w.group ? { group: w.group } : {}),
              cwd: w.cwd, id: w.id, ...(w.agtermSession ? { agtermSession: w.agtermSession } : {}),
            };
          }),
          sessions: sessions.filter(s => s.id !== lead.id).map(s => ({
            id: s.id, name: s.name, status: s.status, cwd: s.cwd, worker: workerName(s.id),
            ...(s.contextPct != null ? { contextPct: s.contextPct } : {}),
            ...(s.lastActivity ? { lastActivity: `${ago(s.lastActivity, now)} ago` } : {}),
          })),
        };
      }
      case "ack":
        if (inbox.delete(req.id)) saveInbox();
        return { acked: req.id };
      case "send": {
        const sessions: SessionInfo[] = workers.has(req.to) ? [] : await client.listSessions();
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
          id: result.id ?? `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), kind: "out",
          text: req.text, peer: w?.name ?? req.to, ...(w ? { worker: w.name } : {}), ...(req.replyTo ? { replyTo: req.replyTo } : {}),
        };
        record(msg);
        if (w) {
          workers.set(w.name, applyOut(w, msg));
          saveWorkers();
        }
        return { ...result, to: target };
      }
      case "read": {
        const w = workers.get(req.name);
        if (!w) throw new Error(`no worker named ${req.name}`);
        if (w.unread) {
          workers.set(w.name, { ...w, unread: 0 });
          saveWorkers();
        }
        return { read: req.name };
      }
      case "focus": {
        const w = workers.get(req.name);
        if (!w?.agtermSession) throw new Error(`worker ${req.name} has no open session`);
        await agterm(["session", "select", "--target", w.agtermSession]);
        return { focused: req.name };
      }
      case "spawn": {
        if (!WORKER_NAME.test(req.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
        if (req.group && !GROUP_NAME.test(req.group)) throw new Error(`group must match ${GROUP_NAME}`);
        const old = workers.get(req.name);
        if (spawning.has(req.name) || (old && old.state !== "gone")) {
          throw new Error(`worker ${req.name} already exists; stop it first`);
        }
        const parent = process.env.AGTERM_SESSION_ID;
        if (!parent) throw new Error("not running inside agterm (AGTERM_SESSION_ID unset)");
        // Claimed before any await, so a second spawn of this name fails the check above.
        spawning.add(req.name);
        try {
          if (req.task && !req.allowDefaultBranch) {
            const branch = await git(req.cwd, ["branch", "--show-current"]);
            const base = branch ? await defaultBranch(git, req.cwd) : undefined;
            if (branch && branch === base) {
              throw new Error(`${req.cwd} is on the default branch ${base}; give the worker its own worktree, or pass allowDefaultBranch: true`);
            }
          }
          const now = Date.now();
          const worker: Worker = {
            name: req.name,
            id: stableId("pi-crew-worker", key, req.name),
            cwd: req.cwd,
            model: req.model || process.env.PI_CREW_DEFAULT_MODEL || DEFAULT_MODEL,
            n: nextNumber(workers.values()),
            ...(req.group ? { group: req.group } : {}),
            state: req.task ? "work" : "idle",
            unread: 0,
            startedAt: now,
            lastAt: now,
            ...(req.task ? { last: { id: `task-${now}`, at: now, text: `you: ${req.task.slice(0, 299)}` } } : {}),
          };
          const wdir = join(dir, "workers", worker.name);
          mkdirSync(wdir, { recursive: true, mode: 0o700 });
          const briefPath = join(wdir, "brief.md");
          writeFileSync(briefPath, workerBrief(lead, worker, req.task), { mode: 0o600 });
          const launch = join(wdir, "launch.sh");
          writeFileSync(launch, launchScript(worker, briefPath));
          chmodSync(launch, 0o700);
          // Recorded before agterm runs, so its id resolves for sends even while the session starts.
          workers.set(worker.name, worker);
          saveWorkers();
          if (req.task) record({ id: `task-${now}-${worker.name}`, at: now, kind: "out", text: req.task, peer: worker.name, worker: worker.name });
          let session: string | undefined;
          let failure = "";
          try {
            const out = await agterm([
              "session", "new", "--after", parent, "--no-select", "--cwd", worker.cwd,
              "--name", worker.name, "--command", launch, "--wait", "--json",
            ]);
            session = parseSessionId(out);
            if (!session) failure = `agtermctl returned no session id: ${out.trim().slice(0, 200)}`;
          } catch (error) {
            failure = `agtermctl session new failed: ${error instanceof Error ? error.message : String(error)}`;
          }
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
      }
      case "stop": {
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
            const detail = errorText(error);
            // A session the user already closed is gone; anything else keeps the record for a retry.
            if (!/no such session/i.test(detail)) throw new Error(`close failed: ${detail.trim()}`);
          }
        }
        workers.set(req.name, { ...worker, state: "gone", agtermSession: undefined, ask: undefined, lastAt: Date.now() });
        saveWorkers();
        publishRoster();
        return { stopped: req.name };
      }
      default:
        throw new Error(`unknown op ${(req as { op?: string }).op}`);
    }
  };

  const sock = controlPath(key);
  rmSync(sock, { force: true });
  const server = createServer((conn: Socket) => {
    conn.setEncoding("utf8");
    conn.setTimeout(REQUEST_IDLE_MS, () => conn.destroy());
    conn.on("error", () => {});
    let buf = "";
    let done = false;
    conn.on("data", async (chunk: string) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length <= REQUEST_LIMIT) return;
      done = true;
      let reply: object;
      try {
        if (nl < 0) throw new Error("request too large");
        reply = { ok: true, ...(await handle(JSON.parse(buf.slice(0, nl)) as Request)) };
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!conn.destroyed) conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(sock, () => chmodSync(sock, 0o600));

  const shutdown = async (code: number) => {
    server.close();
    rmSync(sock, { force: true });
    await client.disconnect().catch(() => {});
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  client.on("disconnected", () => {
    emit({ type: "error", error: "broker disconnected; restarting bridge" });
    void shutdown(1);
  });
  // No stdin watch: a mod-spawned child starts with stdin closed; the engine kills it on unload.
  pruneNow();
  setInterval(() => {
    pruneNow();
    try {
      const now = new Date();
      utimesSync(dir, now, now);
    } catch {}
  }, PRUNE_EVERY_MS).unref();
  emit({
    type: "ready", lead, agtermSession: process.env.AGTERM_SESSION_ID ?? null,
    workers: [...workers.values()], feed: readLines<Msg>(feedFile, FEED_REPLAY),
  });
  for (const pending of inbox.values()) announce(pending);
  publishRoster();
}

function call(key: string, request: string): Promise<number> {
  return new Promise(resolve => {
    const conn = createConnection(controlPath(key));
    conn.setEncoding("utf8");
    let out = "";
    conn.on("connect", () => conn.write(`${request.replace(/\n/g, " ")}\n`));
    conn.on("data", (chunk: string) => (out += chunk));
    conn.on("end", () => {
      process.stdout.write(out);
      let ok = false;
      try {
        ok = JSON.parse(out).ok === true;
      } catch {}
      resolve(ok ? 0 : 1);
    });
    conn.on("error", error => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: `bridge unreachable: ${error.message}` })}\n`);
      resolve(2);
    });
  });
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const [cmd, ...rest] = process.argv.slice(2);
const key = arg(rest, "--key");
if (cmd === "serve" && key && KEY.test(key)) {
  try {
    await serve(key, arg(rest, "--name") ?? `lead-${key.slice(0, 8)}`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ type: "error", error: `bridge start: ${String(error)}` })}\n`);
    process.exit(1);
  }
} else if (cmd === "call" && key && KEY.test(key)) {
  process.exit(await call(key, rest.at(-1) ?? "{}"));
} else {
  process.stderr.write("usage: crew-bridge serve --key <k> [--name <lead>] | call --key <k> '<json>'\n");
  process.exit(1);
}
