// pi-crew bridge: holds one pi-intercom identity for a Claude Code team-lead session.
//
//   crew-bridge serve --key <k> [--name <lead>]   long-lived; JSON events on stdout
//   crew-bridge call  --key <k> '<json request>'   one request to a running bridge
//
// It imports the client from the pi-intercom copy Pi itself installed, so the wire protocol always
// matches the running broker. serve exits 1 when the broker connection drops; the mod restarts it
// under the same id and the broker flushes anything queued meanwhile.
// call exits: 0 ok | 1 usage or request failure | 2 bridge unreachable.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_MODEL, KEY, WORKER_NAME, controlPath, crewDir, intercomPkg, launchScript, parseSessionId, stableId,
  workerBrief, type Worker,
} from "./lib.mts";

const run = promisify(execFile);
const REQUEST_LIMIT = 1 << 20;
const REQUEST_IDLE_MS = 30_000;

type Request =
  | { op: "list" }
  | { op: "send"; to: string; text: string; replyTo?: string }
  | { op: "spawn"; name: string; cwd: string; model?: string; task?: string }
  | { op: "stop"; name: string }
  | { op: "ack"; id: string };

type Inbound = {
  type: "message";
  from: { id: string; name?: string; cwd: string; worker?: string };
  id: string;
  replyTo?: string;
  expectsReply: boolean;
  text: string;
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
  const workersFile = join(dir, "workers.json");
  const inboxFile = join(dir, "inbox.json");
  const workers = new Map<string, Worker>(readJson<Worker[]>(workersFile, []).map(w => [w.name, w]));
  const saveWorkers = () => writeJson(workersFile, [...workers.values()]);
  // Reports the lead has not yet taken in. Kept on disk so a bridge restart or mod reload replays them.
  const inbox = new Map<string, Inbound>(readJson<Inbound[]>(inboxFile, []).map(m => [m.id, m]));
  const saveInbox = () => writeJson(inboxFile, [...inbox.values()]);
  const workerName = (id: string) => [...workers.values()].find(w => w.id === id)?.name;

  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const lead = { name: leadName, id: stableId("pi-crew-lead", key) };
  const client = new IntercomClient();

  let rosterTimer: NodeJS.Timeout | undefined;
  const publishRoster = () => {
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(async () => {
      try {
        const sessions = await client.listSessions();
        emit({
          type: "roster",
          sessions: sessions
            .filter((s: { id: string }) => s.id !== lead.id)
            .map((s: { id: string; name?: string; status?: string; cwd: string; model: string }) => ({
              id: s.id, name: s.name, status: s.status, cwd: s.cwd, model: s.model, worker: workerName(s.id),
            })),
        });
      } catch (error) {
        emit({ type: "error", error: `roster: ${String(error)}` });
      }
    }, 250);
  };

  // Handlers first: the broker flushes queued mailbox messages at registration.
  client.on("message", (from: { id: string; name?: string; cwd: string }, message: {
    id: string; replyTo?: string; expectsReply?: boolean; content: { text: string };
  }) => {
    if (!inbox.has(message.id)) {
      const event: Inbound = {
        type: "message",
        from: { id: from.id, name: from.name, cwd: from.cwd, worker: workerName(from.id) },
        id: message.id,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        expectsReply: message.expectsReply === true,
        text: message.content.text,
      };
      inbox.set(message.id, event);
      saveInbox();
      emit(event);
    }
    // Stored on disk: tell the sender it arrived. A crash before this makes the sender see a retryable failure.
    client.sendMessageReceipt({ messageId: message.id, status: "receiver_received", timestamp: Date.now() });
  });
  client.onBrokerMessage((m: { type: string }) => {
    if (m.type === "session_joined" || m.type === "session_left" || m.type === "presence_update") publishRoster();
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
  const spawning = new Set<string>();

  const handle = async (req: Request): Promise<object> => {
    switch (req.op) {
      case "list":
        return { sessions: await client.listSessions(), workers: [...workers.values()] };
      case "ack":
        if (inbox.delete(req.id)) saveInbox();
        return { acked: req.id };
      case "send": {
        const target = workers.get(req.to)?.id ?? req.to;
        const result = await client.send(target, { text: req.text, ...(req.replyTo ? { replyTo: req.replyTo } : {}) });
        if (!result.delivered) throw new Error(`not delivered to ${req.to}: ${result.reason ?? "unknown"}${result.code ? ` (${result.code})` : ""}`);
        return { ...result, to: target };
      }
      case "spawn": {
        if (!WORKER_NAME.test(req.name)) throw new Error(`worker name must match ${WORKER_NAME}`);
        if (spawning.has(req.name) || workers.get(req.name)?.agtermSession) {
          throw new Error(`worker ${req.name} already exists; stop it first`);
        }
        const parent = process.env.AGTERM_SESSION_ID;
        if (!parent) throw new Error("not running inside agterm (AGTERM_SESSION_ID unset)");
        spawning.add(req.name);
        try {
          const worker: Worker = {
            name: req.name,
            id: stableId("pi-crew-worker", key, req.name),
            cwd: req.cwd,
            model: req.model || process.env.PI_CREW_DEFAULT_MODEL || DEFAULT_MODEL,
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
          const out = await agterm([
            "session", "new", "--after", parent, "--no-select", "--cwd", worker.cwd,
            "--name", worker.name, "--command", launch, "--wait", "--json",
          ]);
          worker.agtermSession = parseSessionId(out);
          saveWorkers();
          if (!worker.agtermSession) throw new Error(`agtermctl returned no session id: ${out.trim().slice(0, 200)}`);
          publishRoster();
          return { worker };
        } finally {
          spawning.delete(req.name);
        }
      }
      case "stop": {
        const worker = workers.get(req.name);
        if (!worker) throw new Error(`no worker named ${req.name}`);
        if (worker.agtermSession) {
          try {
            await agterm(["session", "close", "--target", worker.agtermSession]);
          } catch (error) {
            const detail = `${(error as { stdout?: string }).stdout ?? ""} ${error instanceof Error ? error.message : String(error)}`;
            // A session the user already closed is gone; anything else keeps the record for a retry.
            if (!/no such session/i.test(detail)) throw new Error(`close failed: ${detail.trim()}`);
          }
        }
        workers.delete(req.name);
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
  emit({ type: "ready", lead, agtermSession: process.env.AGTERM_SESSION_ID ?? null, workers: [...workers.values()] });
  for (const pending of inbox.values()) emit(pending);
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
