import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("typecheck explains missing Claude Code types without running the compiler", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-crew-typecheck-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  const script = join(dir, "bin/typecheck");
  writeFileSync(script, readFileSync(new URL("../bin/typecheck", import.meta.url)));
  const cache = join(dir, "cache");
  mkdirSync(join(cache, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(cache, "node_modules/@types/node"), { recursive: true });
  writeFileSync(join(cache, "node_modules/.bin/tsc"), "#!/bin/sh\nprintf compiled > compiler-ran\n", { mode: 0o755 });

  const result = spawnSync("sh", [script], {
    cwd: dir,
    env: { ...process.env, PI_CREW_TYPECHECK_DIR: cache },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Claude Code types are missing/);
  assert.match(result.stderr, /--plugin-dir/);
  assert.deepEqual(readdirSync(dir).sort(), ["bin", "cache"]);
});
