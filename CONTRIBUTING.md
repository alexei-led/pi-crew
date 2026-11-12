# Contributing

## Setup

You need Node.js, git, npm, a mod-capable Claude Code installation, and Pi with pi-intercom and its sibling tsx.
Follow the [runtime setup](README.md#install) before trying real workers.

This project has no `package.json`.
The bridge and tests reuse Pi's installed loader and intercom package.
`bin/typecheck` installs `typescript@7` and `@types/node` into a temporary cache on first use.

Generate Claude Code's ignored type declarations by loading the checkout once:

```sh
claude --plugin-dir .
```

Exit the session, then run checks from the repository root:

```sh
bin/test
claude plugin test .
bin/typecheck
claude plugin validate .
```

Set `PI_CREW_TYPECHECK_DIR` to override the default `${TMPDIR:-/tmp}/pi-crew-typecheck` cache.
The first typecheck needs network access. Later runs reuse the installed compiler.

## Test boundaries

| Check | Exercises |
| --- | --- |
| `bin/test` | Parsers, state, git checks, crew operations, and a real bridge/broker round trip with fake agterm. |
| `claude plugin test .` | Mod prompt delivery, replay handling, band/pane rendering, and keyboard actions. |
| `bin/typecheck` | Strict TypeScript checks for the mod, bridge, shared contracts, and tests. |
| `claude plugin validate .` | Plugin, marketplace, and hook validation. This is not a security review. |

Use a regression test at the affected boundary. Unit and integration tests can exercise the same feature for different failures.
Do not remove one solely because another mentions the same behavior.

For a manual check, spawn a worker in a disposable worktree.
Exercise a question, progress, DONE, a plugin reload, and stop.
Automated tests do not launch a real Pi worker or inspect a live agterm/Claude Code screen.

## Scope

Keep changes small. Follow the existing module boundaries and shared types.
Update the [user guide](docs/guide.md) when behavior changes and the [architecture](docs/architecture.md) when contracts change.
Never include credentials, private prompts, local settings, or worker logs in a patch.
