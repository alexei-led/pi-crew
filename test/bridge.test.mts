// Runs the real bridge against a real pi-intercom broker in a throwaway agent dir, with a fake agtermctl.
import { strict as assert } from "node:assert";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { intercomPkg, stableId } from "../bridge/lib.mts";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const bin = join(root, "bin/crew-bridge");
const pkg = intercomPkg();
const KEY = "lead-pane-1";

const tmp = mkdtempSync(join(tmpdir(), "pi-crew-it-"));
const fakeBin = join(tmp, "bin");
mkdirSync(fakeBin);
const agtermLog = join(tmp, "agterm.log");
writeFileSync(
  join(fakeBin, "agtermctl"),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${agtermLog}'
case "$1 $2" in
  "session new") echo '{"ok":true,"result":{"id":"agterm-worker-1"}}' ;;
  "session close") [ "$4" = gone ] && { echo '{"ok":false,"error":"no such session: gone"}'; exit 1; }
                   [ "$4" = stuck ] && { echo '{"ok":false,"error":"busy"}'; exit 1; }
                   echo '{"ok":true}' ;;
esac
`,
);
chmodSync(join(fakeBin, "agtermctl"), 0o755);

const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: join(tmp, "agent"),
  PI_CREW_DIR: join(tmp, "crew"),
  PI_CREW_INTERCOM_PKG: pkg,
  AGTERM_SESSION_ID: "lead-agterm",
  PATH: `${fakeBin}:${process.env.PATH}`,
};
// The worker-side client must see the same broker dir before pi-intercom computes its paths.
process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
const { IntercomClient } = await import(join(pkg, "broker/client.ts"));

type Event = Record<string, any>;
class Bridge {
  proc: ChildProcess;
  events: Event[] = [];
  private waiters: Array<() => void> = [];
  constructor() {
    this.proc = spawn(bin, ["serve", "--key", KEY, "--name", "test-lead"], { env, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    this.proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        this.events.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        for (const w of this.waiters.splice(0)) w();
      }
    });
  }
  async next(pred: (e: Event) => boolean, ms = 20_000): Promise<Event> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timeout; events: ${JSON.stringify(this.events)}`);
      await new Promise<void>(resolve => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }
  async stop() {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise(resolve => this.proc.once("exit", resolve));
    this.proc.kill("SIGTERM");
    await exited;
  }
}

async function call(request: object): Promise<{ code: number; body: Event }> {
  try {
    const { stdout } = await run(bin, ["call", "--key", KEY, JSON.stringify(request)], { env });
    return { code: 0, body: JSON.parse(stdout) };
  } catch (error: any) {
    return { code: error.code, body: JSON.parse(error.stdout) };
  }
}

const leadId = stableId("pi-crew-lead", KEY);
const workerId = stableId("pi-crew-worker", KEY, "api");
const clients: any[] = [];
let bridge: Bridge | undefined;
after(async () => {
  await bridge?.stop();
  for (const c of clients) await c.disconnect().catch(() => {});
});

async function workerClient() {
  const client = new IntercomClient();
  const inbox: any[] = [];
  client.on("message", (_from: unknown, message: any) => inbox.push(message));
  await client.connect({ cwd: tmp, model: "fake", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), name: "api" }, workerId);
  clients.push(client);
  return { client, inbox };
}

test("bridge round trip: start broker, spawn, both directions, replay until ack, stop", async t => {
  bridge = new Bridge();
  const ready = await bridge.next(e => e.type === "ready");
  assert.equal(ready.lead.id, leadId);

  await t.test("spawn writes brief and launcher and records the agterm session", async () => {
    const { code, body } = await call({ op: "spawn", name: "api", cwd: tmp, task: "say hi" });
    assert.equal(code, 0, JSON.stringify(body));
    assert.equal(body.worker.id, workerId);
    assert.equal(body.worker.agtermSession, "agterm-worker-1");
    const wdir = join(env.PI_CREW_DIR, KEY, "workers/api");
    assert.match(readFileSync(join(wdir, "brief.md"), "utf8"), new RegExp(leadId));
    assert.ok(existsSync(join(wdir, "launch.sh")));
    assert.match(readFileSync(agtermLog, "utf8"), /session new --after lead-agterm --no-select/);
    assert.equal((await call({ op: "spawn", name: "api", cwd: tmp })).code, 1);
    assert.equal((await call({ op: "spawn", name: "Bad Name", cwd: tmp })).code, 1);
  });

  const worker = await workerClient();

  await t.test("lead → worker by name; failed delivery is an error", async () => {
    const { code, body } = await call({ op: "send", to: "api", text: "task 2" });
    assert.equal(code, 0, JSON.stringify(body));
    for (let i = 0; i < 50 && worker.inbox.length === 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(worker.inbox[0]?.content.text, "task 2");
    const bad = await call({ op: "send", to: "00000000-0000-4000-8000-000000000000", text: "x" });
    assert.equal(bad.code, 1);
    assert.equal(bad.body.ok, false);
  });

  let reportId = "";
  await t.test("worker → lead arrives as a message event tagged with the worker name", async () => {
    const sent = await worker.client.send(leadId, { text: "done: hi" });
    assert.equal(sent.delivered, true);
    reportId = sent.id;
    const ev = await bridge!.next(e => e.type === "message" && e.id === reportId);
    assert.equal(ev.from.worker, "api");
    assert.equal(ev.text, "done: hi");
  });

  await t.test("an un-acked report is replayed after a bridge restart, an acked one is not", async () => {
    await bridge!.stop();
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    await bridge.next(e => e.type === "message" && e.id === reportId);
    assert.equal((await call({ op: "ack", id: reportId })).code, 0);
    await bridge.stop();
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    await new Promise(r => setTimeout(r, 500));
    assert.equal(bridge.events.filter(e => e.type === "message").length, 0);
  });

  await t.test("a report sent while the bridge is down is queued and delivered on restart", async () => {
    await bridge!.stop();
    const sent = await worker.client.send(leadId, { text: "while you were out" });
    assert.equal(sent.delivered, true);
    bridge = new Bridge();
    await bridge.next(e => e.type === "message" && e.text === "while you were out");
  });

  await t.test("list returns sessions and workers", async () => {
    const { code, body } = await call({ op: "list" });
    assert.equal(code, 0);
    assert.ok(body.sessions.some((s: any) => s.id === workerId));
    assert.equal(body.workers[0].name, "api");
  });

  await t.test("stop keeps the worker when close fails, forgets it when the session is gone", async () => {
    const file = join(env.PI_CREW_DIR, KEY, "workers.json");
    const setSession = (id: string) => {
      const ws = JSON.parse(readFileSync(file, "utf8"));
      ws[0].agtermSession = id;
      writeFileSync(file, JSON.stringify(ws));
    };
    await bridge!.stop();
    setSession("stuck");
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    assert.equal((await call({ op: "stop", name: "api" })).code, 1);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1);
    await bridge.stop();
    setSession("gone");
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    assert.equal((await call({ op: "stop", name: "api" })).code, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 0);
  });

  await t.test("call to a missing bridge exits 2", async () => {
    await bridge!.stop();
    const { code, body } = await call({ op: "list" });
    assert.equal(code, 2);
    assert.match(body.error, /bridge unreachable/);
  });
});
