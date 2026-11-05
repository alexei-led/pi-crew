import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WORKER_NAME, launchScript, parseSessionId, stableId, workerBrief, type Worker } from "../bridge/lib.mts";

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
  const worker: Worker = { name: "api", id: "w", cwd: "/x", model: "m" };
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
  const worker: Worker = { name: "api", id: "id-1", cwd, model: "router/x; echo boom" };
  const brief = join(dir, "brief $x.md");
  const script = join(dir, "launch.sh");
  writeFileSync(script, launchScript(worker, brief, { PATH: process.env.PATH, PI_CREW_PI_COMMAND: fake }));
  const out = execFileSync("sh", [script], { encoding: "utf8", cwd: dir }).trim().split("\n");
  assert.deepEqual(out.slice(1), ["id-1", "--model", "router/x; echo boom", "--name", "api", `@${brief}`]);
  assert.equal(realpathSync(out[0]!), realpathSync(cwd));
  assert.throws(() => execFileSync("test", ["-e", join(dir, "pwned")]));
});
