// pi-crew bridge: holds one pi-intercom identity for a Claude Code team-lead session.
//
//   crew-bridge serve --key <k> [--name <lead>]   long-lived; JSON events on stdout
//   crew-bridge call  --key <k> '<json request>'   one request to a running bridge
//
// It imports the client from the pi-intercom copy Pi itself installed, so the wire protocol always
// matches the running broker. serve exits 1 when the broker connection drops; the mod restarts it
// under the same id and the broker flushes anything queued meanwhile.
// call exits: 0 ok | 1 usage or request failure | 2 bridge unreachable.
//
// This file is the process shell: argv, the control socket, the broker connection, signals and timers.
// The crew's state and what each request does live in crew.mts.
import { chmodSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createCrew, type IntercomClient } from "./crew.mts";
import { KEY, controlPath, crewDir, crewRoot, errorMessage, historyLimit, idleMs, intercomPkg, type Git } from "./lib.mts";
import type { BridgeEvent } from "../types/index.d.ts";

const run = promisify(execFile);
const REQUEST_LIMIT = 1 << 20;
const REQUEST_IDLE_MS = 30_000;
/** How long a worker that left the broker has to come back before its agterm session is checked. */
const EXIT_CHECK_MS = Number(process.env.PI_CREW_EXIT_CHECK_MS) || 3_000;
const PRUNE_EVERY_MS = 5 * 60_000;
/** A crew directory of another agterm pane with no change for this long is removed at bridge start. */
const STALE_CREW_MS = 7 * 86_400_000;

const git: Git = async (cwd, args) => {
  try {
    return (await run("git", ["-C", cwd, ...args], { timeout: 10_000 })).stdout.trim();
  } catch {
    return undefined; // the Git contract: undefined when git fails
  }
};

const agterm = async (args: string[]) => (await run("agtermctl", args, { timeout: 15_000 })).stdout;

function removeStaleCrews(keep: string) {
  const root = crewRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return; // no crew root yet: nothing to remove
  }
  for (const name of names) {
    if (name === keep || !KEY.test(name)) continue;
    const dir = join(root, name);
    try {
      // An append to feed.jsonl leaves the directory's own mtime alone, so take the newest file. A running
      // bridge touches its directory every prune interval, so it never looks stale.
      const newest = Math.max(statSync(dir).mtimeMs, ...readdirSync(dir).map(f => statSync(join(dir, f)).mtimeMs));
      if (Date.now() - newest > STALE_CREW_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another bridge may be removing or using it; leave it for the next start.
    }
  }
}

async function serve(key: string, leadName: string) {
  const pkg = intercomPkg();
  // The one cast of the untyped import; IntercomClient mirrors the part of the class the bridge uses.
  const { IntercomClient: Client } = (await import(join(pkg, "broker/client.ts"))) as { IntercomClient: new () => IntercomClient };
  const { spawnBrokerIfNeeded } = await import(join(pkg, "broker/spawn.ts"));
  const { loadConfig } = await import(join(pkg, "config.ts"));

  const dir = crewDir(key);
  removeStaleCrews(key);
  const emit = (event: BridgeEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const client = new Client();
  const crew = createCrew(dir, {
    key, leadName, emit, client, agterm, git, now: Date.now,
    agtermSession: process.env.AGTERM_SESSION_ID,
    defaultModel: process.env.PI_CREW_DEFAULT_MODEL,
    exitCheckMs: EXIT_CHECK_MS,
    idleMs: idleMs(),
    historyLimit: historyLimit(),
  });

  // Handlers first: the broker flushes queued mailbox messages at registration.
  client.on("message", crew.onMessage);
  client.onBrokerMessage(crew.onBrokerMessage);
  client.on("error", error => emit({ type: "error", error: errorMessage(error) }));
  const cfg = loadConfig();
  await spawnBrokerIfNeeded(cfg.brokerCommand, cfg.brokerArgs);
  await client.connect(
    {
      cwd: process.cwd(), model: "claude-code-lead", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(),
      name: crew.lead.name, status: "lead", acknowledgesReceipts: true,
    },
    crew.lead.id,
  );

  const idle = idleMs();
  if (idle) {
    const every = Number(process.env.PI_CREW_IDLE_CHECK_MS) || Math.min(60_000, Math.max(1_000, idle / 4));
    setInterval(() => void crew.checkIdle().catch(error => emit({ type: "error", error: `idle: ${errorMessage(error)}` })), every).unref();
  }

  const sock = controlPath(key);
  rmSync(sock, { force: true });
  const server = createServer((conn: Socket) => {
    conn.setEncoding("utf8");
    conn.setTimeout(REQUEST_IDLE_MS, () => conn.destroy());
    conn.on("error", () => {
      // A client that hangs up mid-request has nobody left to tell.
    });
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
        reply = { ok: true, ...(await crew.handle(JSON.parse(buf.slice(0, nl)))) };
      } catch (error) {
        reply = { ok: false, error: errorMessage(error) };
      }
      if (!conn.destroyed) conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(sock, () => chmodSync(sock, 0o600));

  const shutdown = async (code: number) => {
    server.close();
    rmSync(sock, { force: true });
    await client.disconnect().catch(() => {
      // Leaving anyway; the broker notices the closed socket.
    });
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  client.on("disconnected", () => {
    emit({ type: "error", error: "broker disconnected; restarting bridge" });
    void shutdown(1);
  });
  // No stdin watch: a mod-spawned child starts with stdin closed; the engine kills it on unload.
  crew.prune();
  setInterval(() => {
    try {
      crew.prune();
    } catch (error) {
      emit({ type: "error", error: `prune: ${errorMessage(error)}` });
    }
    try {
      const now = new Date();
      utimesSync(dir, now, now);
    } catch {
      // Only keeps the directory from looking stale; the next interval tries again.
    }
  }, PRUNE_EVERY_MS).unref();
  crew.ready();
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
      } catch {
        // A reply that is not JSON is a failure; the raw text was printed above.
      }
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
    process.stdout.write(`${JSON.stringify({ type: "error", error: `bridge start: ${errorMessage(error)}` })}\n`);
    process.exit(1);
  }
} else if (cmd === "call" && key && KEY.test(key)) {
  process.exit(await call(key, rest.at(-1) ?? "{}"));
} else {
  process.stderr.write("usage: crew-bridge serve --key <k> [--name <lead>] | call --key <k> '<json>'\n");
  process.exit(1);
}
