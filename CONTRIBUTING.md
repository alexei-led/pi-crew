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
Exercise a question, progress, DONE, history paging, a plugin reload, and stop through the lead.
Check that browsing does not change manager unread/inbox state. New reports must not move a pinned history view.
Verify inline and docked placement, explicit assignments, and separation after respawning a worker name.
Automated tests do not launch a real Pi worker or inspect a live agterm/Claude Code screen.

The 0.6.0 manual check used Claude Code 2.1.323, Pi 1.5.2, and agterm 0.41.1 in a disposable git repository.
It covered a real question/answer, progress and DONE, and both pane placements.
It also checked pinned history, observer side effects, assignment persistence, legacy sender labels, and respawned-run isolation.
These are tested versions, not minimum version requirements.

## Mixed crew acceptance

The 0.7.0 live check used Claude Code 2.1.323 routed through `claude-ds`, Pi 1.5.2, pi-intercom 0.18.1, pi-subagents 0.88.1, and agterm 0.41.1.
A disposable Claude lead managed a real Pi worker and native Claude workers. The check covered:

- Pi progress, question/reply and DONE with git evidence; separate Pi/Claude roster sections.
- Native assignments, communication in both directions, final turn reports, named workers and resumed turns.
- Native messages and an explicit conversation snapshot rendered in the real pane; browsing left the Pi inbox and unread count unchanged.
- Plugin reload with retained observations and conversation reset after `/clear`. The host can remove a completed worker from its live roster; its observer row then says not tracked rather than claiming termination.

A separate real Pi lead ran a native Pi child and a Claude CLI child through pi-subagents' parallel workflow. Both returned their requested markers.
The Claude CLI used the existing DeepSeek launcher in a disposable wrapper that moved launcher banners to stderr; its adapter remained read-only and one-shot. No installed Pi extension or user agent definition was changed.

Repeat in a disposable repository with synthetic markers and one worktree per editing worker.
Verify native ownership after clear/resume, frozen reading with incoming messages, and both inline/docked placement.
Unit tests cover denied cross-process conversation reads and unverified teammate-mailbox attribution; do not mistake those fixtures for live pane-hosted transcript validation.
Remove probe-owned agents, terminal sessions, runner artifacts, temporary configuration and directories after checking the results.
Never commit raw prompts, credentials or private transcripts as fixtures.

## Scope

Keep changes small. Follow the existing module boundaries and shared types.
Update the [user guide](docs/guide.md) when behavior changes and the [architecture](docs/architecture.md) when contracts change.
Never include credentials, private prompts, local settings, or worker logs in a patch.
