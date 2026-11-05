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
const closedMarker = join(tmp, "worker-closed");
writeFileSync(
  join(fakeBin, "agtermctl"),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${agtermLog}'
case "$1 $2" in
  "session new") echo '{"ok":true,"result":{"id":"agterm-worker-1"}}' ;;
  "session select") echo '{"ok":true}' ;;
  "session text") [ -e '${closedMarker}' ] && { echo '{"ok":false,"error":"no such session: x"}'; exit 1; }
                  echo 'screen' ;;
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
  PI_CREW_EXIT_CHECK_MS: "300",
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
    const { code, body } = await call({ op: "spawn", name: "api", cwd: tmp, task: "say hi", group: "backend" });
    assert.equal(code, 0, JSON.stringify(body));
    assert.equal(body.worker.id, workerId);
    assert.equal(body.worker.agtermSession, "agterm-worker-1");
    assert.deepEqual([body.worker.n, body.worker.group, body.worker.state], [1, "backend", "work"]);
    await bridge!.next(e => e.type === "feed" && e.msg.kind === "out" && e.msg.text === "say hi");
    assert.equal((await call({ op: "spawn", name: "web", cwd: tmp, group: "Bad Group" })).code, 1);
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
    assert.equal(ev.kind, "done");
    const feed = await bridge!.next(e => e.type === "feed" && e.msg.id === reportId);
    assert.deepEqual([feed.msg.kind, feed.msg.text, feed.msg.worker], ["done", "hi", "api"]);
    const w = await bridge!.next(e => e.type === "workers" && e.workers[0].unread === 1);
    assert.equal(w.workers[0].state, "idle");
  });

  await t.test("a Q: report opens a question; the lead's answer closes it; read clears unread", async () => {
    const asked = await worker.client.send(leadId, { text: "Q: drop the old table?" });
    const open = await bridge!.next(e => e.type === "workers" && e.workers[0].state === "ask");
    assert.deepEqual([open.workers[0].ask.id, open.workers[0].ask.text, open.workers[0].unread], [asked.id, "drop the old table?", 2]);
    await worker.client.send(leadId, { text: "still checking" });
    await bridge!.next(e => e.type === "workers" && e.workers[0].unread === 3 && e.workers[0].state === "ask");
    const answer = await call({ op: "send", to: "api", text: "yes", replyTo: asked.id });
    assert.equal(answer.code, 0, JSON.stringify(answer.body));
    const answered = await bridge!.next(e => e.type === "workers" && e.workers[0].state === "work");
    assert.deepEqual([answered.workers[0].ask, answered.workers[0].unread], [undefined, 0]);
    await worker.client.send(leadId, { text: "progress" });
    await bridge!.next(e => e.type === "workers" && e.workers[0].unread === 1);
    assert.equal((await call({ op: "read", name: "api" })).code, 0);
    await bridge!.next(e => e.type === "workers" && e.workers[0].unread === 0 && e.workers[0].last.text === "progress");
    assert.equal((await call({ op: "focus", name: "api" })).code, 0);
    assert.match(readFileSync(agtermLog, "utf8"), /session select --target agterm-worker-1/);
    for (const id of [asked.id]) await call({ op: "ack", id });
  });

  await t.test("an un-acked report is replayed after a bridge restart, an acked one is not", async () => {
    await bridge!.stop();
    bridge = new Bridge();
    const ready = await bridge.next(e => e.type === "ready");
    assert.ok(ready.feed.some((m: any) => m.id === reportId), "ready replays the feed");
    assert.equal(ready.workers[0].n, 1);
    await bridge.next(e => e.type === "message" && e.id === reportId);
    assert.equal((await call({ op: "ack", id: reportId })).code, 0);
    await bridge.stop();
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    await new Promise(r => setTimeout(r, 500));
    assert.deepEqual(bridge.events.filter(e => e.type === "message").map(e => e.id).filter(id => id === reportId), []);
  });

  await t.test("a report sent while the bridge is down is queued and delivered on restart", async () => {
    await bridge!.stop();
    const sent = await worker.client.send(leadId, { text: "while you were out" });
    assert.equal(sent.delivered, true);
    bridge = new Bridge();
    await bridge.next(e => e.type === "message" && e.text === "while you were out");
  });

  await t.test("an intercom ask is answered with replyTo after a bridge restart, and as a plain message once the worker gave up", async () => {
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 50 && !worker.inbox.some(pred); i++) await new Promise(r => setTimeout(r, 100));
      return worker.inbox.find(pred);
    };
    const asked = await worker.client.send(leadId, { text: "which port?", expectsReply: true });
    await bridge!.next(e => e.type === "message" && e.id === asked.id);
    await call({ op: "ack", id: asked.id });
    await bridge!.stop();
    bridge = new Bridge();
    await bridge.next(e => e.type === "ready");
    assert.equal((await call({ op: "send", to: "api", text: "8080", replyTo: asked.id })).code, 0);
    assert.equal((await waitFor(m => m.content.text === "8080"))?.replyTo, asked.id);

    const dropped = await worker.client.send(leadId, { text: "which host?", expectsReply: true });
    await bridge.next(e => e.type === "message" && e.id === dropped.id);
    await call({ op: "ack", id: dropped.id });
    worker.client.cancelAsk(dropped.id);
    await new Promise(r => setTimeout(r, 200));
    const late = await call({ op: "send", to: "api", text: "localhost", replyTo: dropped.id });
    assert.equal(late.code, 0, JSON.stringify(late.body));
    assert.equal((await waitFor(m => m.content.text === "localhost"))?.replyTo, undefined);
  });

  await t.test("list returns sessions and workers", async () => {
    const { code, body } = await call({ op: "list" });
    assert.equal(code, 0);
    assert.ok(body.sessions.some((s: any) => s.id === workerId));
    assert.equal(body.workers[0].name, "api");
  });

  await t.test("a worker that leaves the broker stays live while its session is open, is stopped once closed", async () => {
    await worker.client.disconnect();
    await new Promise(r => setTimeout(r, 1200));
    const before = bridge!.events.filter(e => e.type === "workers").at(-1);
    assert.notEqual(before?.workers[0].state, "gone");
    const again = await workerClient();
    writeFileSync(closedMarker, "");
    await again.client.disconnect();
    const gone = await bridge!.next(e => e.type === "workers" && e.workers[0].state === "gone");
    assert.equal(gone.workers[0].agtermSession, undefined);
  });

  await t.test("stop keeps the worker when close fails, marks it gone, then a second stop forgets it", async () => {
    const file = join(env.PI_CREW_DIR, KEY, "workers.json");
    const setSession = (id: string) => {
      const ws = JSON.parse(readFileSync(file, "utf8"));
      ws[0].agtermSession = id;
      ws[0].state = "work";
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
    const gone = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual([gone.length, gone[0].state, gone[0].agtermSession], [1, "gone", undefined]);
    const again = await call({ op: "spawn", name: "api", cwd: tmp });
    assert.equal(again.code, 0, JSON.stringify(again.body));
    assert.equal(again.body.worker.n, 2, "numbers are never reused");
    assert.equal((await call({ op: "stop", name: "api" })).code, 0);
    assert.equal((await call({ op: "stop", name: "api" })).code, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 0);
    const feed = readFileSync(join(env.PI_CREW_DIR, KEY, "feed.jsonl"), "utf8");
    assert.doesNotMatch(feed, /"worker":"api"/, "forgetting a worker drops its messages");
    await bridge!.next(e => e.type === "feedset" && e.feed.every((m: any) => m.worker !== "api"));
  });

  await t.test("call to a missing bridge exits 2", async () => {
    await bridge!.stop();
    const { code, body } = await call({ op: "list" });
    assert.equal(code, 2);
    assert.match(body.error, /bridge unreachable/);
  });
});
