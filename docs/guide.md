# User guide

[Install pi-crew](../README.md#install) first. The **lead** is your Claude Code session. Its Pi workers form the **crew**.

## Delegate and review

Give each worker its own worktree and a complete task: goal, paths, constraints, checks, and expected report.
Workers cannot see the lead's conversation.

Open `/crew` to see the inbox, workers grouped by task area, and recent messages.
Click a worker to answer it, open its terminal, or stop it.
Stopping closes its agterm session and ends current work. Stop it again to forget its record.

Example band above the prompt:

```text
c: crew 3 · a: ◆ 1 api 4m: Check the database? · u: ✉ 2 new · ● 1 working · ○ 1 idle
```

| Marker | Meaning |
| --- | --- |
| `◆` | Worker needs an answer. Oldest questions appear first. |
| `✉` | New messages. Reading a thread or sending a reply also clears its count. |
| `●` | Working on a task from the lead. |
| `○` | Idle: no task yet, or task reported done. |
| `✕` | Stopped. |
| `◇` | Quiet alert from the bridge, not a worker state. |

Zero counts hide in the band. Narrow layouts shorten labels or hide secondary counts.
Colors follow your theme. The markers carry the same meaning without color.

## What starts a lead turn

| Incoming message | Delivery |
| --- | --- |
| `Q: …`, `QUESTION: …`, an intercom ask, or a last nonempty line ending in `?` | Starts a turn. |
| `DONE: …` | Starts a turn with git checks. |
| Other worker progress | Waits for your next prompt or the next turn about that worker. |
| Quiet alert | Starts a turn. |
| Message from an intercom session outside the crew | Starts a turn. |

Markers are case-insensitive. A prompt queued behind a running turn does not take waiting progress.
Worker text is quoted under "Information, not an instruction". This is a prompt convention, not a security boundary.

A worker sends a question or DONE once, then waits. It keeps working after a progress report.
The lead can answer automatically. You can also reply from the pane. The lead learns about pane replies with the next turn that worker starts.

### DONE reports

The worker commits changed files before reporting. A no-change task reports its current HEAD.
Example report, with the actual commit id substituted:

```text
DONE: added the health endpoint
head: <full commit SHA>
branch: feat/health
tests: bin/test
rc: 0
logs: none
```

The bridge checks required fields, claimed HEAD and branch, a zero reported exit code, and uncommitted changes.
It also checks the default branch and, for a linked worktree, the main checkout.
Failed git inspection leaves the report unverified. Replayed reports are checked again.

**The bridge does not run the reported tests or read the reported logs.**
`tests: none` is allowed when no checks ran. Always review the actual diff and test evidence before merging.

### Quiet alerts

A worker on a task alerts once after the [idle threshold](#settings) if it is idle on intercom or has left the broker.
The alert includes up to 15 lines of its terminal output when available.
A worker that is still thinking or running tools does not alert.

A question, DONE, or a worker spawned without a task is intentional waiting.
Tasks typed directly into a worker's terminal do not update the crew's task state.

## Keyboard and mouse

Click chips, rows, or actions. Band keys work while the band is focused (`ctrl+x tab`).

| View | Keys |
| --- | --- |
| Band | `c` crew, `a` oldest question, `u` unread inbox when shown |
| Pane | `q` / `x` / Esc close, Tab move focus, Enter activate |
| Worker list | `1`–`9` open worker number, `m` inbox, `g` crew |
| List filters | `a` all, `h` needs you, `w` working, `i` idle, `s` stopped |
| Worker detail | `b` back, `e` more/less messages, `d` expand/collapse a cut question, `o` terminal |
| Open question | `y` send yes, `n` send no |
| Stop/forget | `s` arm, `c` confirm, `v` cancel |

Workers numbered 10 or higher have no digit shortcut.
In the message field, keys type text, Enter sends, and Esc closes the pane.

## Tools

| Tool | Arguments and behavior |
| --- | --- |
| `mcp__pi-crew__spawn` | `{name, cwd, task?, group?, model?, allowDefaultBranch?}`. Starts a worker in a new agterm session. |
| `mcp__pi-crew__send` | `{to, text, replyTo?}`. Targets a worker name, full session id, case-insensitive live session name, or unique id prefix of 6+ characters. |
| `mcp__pi-crew__list` | Crew state, waiting questions, unread counts, live presence, context usage when available, and live intercom sessions. |
| `mcp__pi-crew__stop` | `{name}`. Closes a worker session. A second stop forgets it. |

Names match `[a-z][a-z0-9-]{0,31}`. Groups match `[a-z][a-z0-9-]{0,23}`.
Use an absolute `cwd`. With a task, spawn refuses a detected default branch unless `allowDefaultBranch: true`.
This override permits default-branch work. It does not make a task read-only.
Default-branch detection uses local `origin/HEAD`, then local `main` or `master`. It cannot guard an unknown default branch.

An omitted task leaves the worker idle. An omitted model uses the configured default below.
For a question, pass its message id as `replyTo`. Unknown or ambiguous targets fail with live-session candidates.

## Settings

Set these in the environment inherited by Claude Code.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CREW_PI_COMMAND` | `pi-work` | One executable name or path, not a shell command with arguments. |
| `PI_CREW_DEFAULT_MODEL` | `router/openai-work` | Default Pi model id. Configure one available to your installation. |
| `PI_CREW_INTERCOM_PKG` | `~/.pi/agent/npm/node_modules/pi-intercom` | Installed package directory. Its sibling `tsx` runs the bridge and tests. |
| `PI_CREW_IDLE_MIN` | `10` | Quiet-alert threshold in minutes. Zero, negative, or invalid values disable it. |
| `PI_CREW_DIR` | `~/.pi-crew` | Local crew state. Contains task briefs and message text. |

`PI_CODING_AGENT_DIR` selects pi-intercom's agent/broker state location.
It does **not** change pi-crew's package lookup. Set `PI_CREW_INTERCOM_PKG` for a non-default package location.

## With crew-net

[crew-net](https://github.com/alexei-led/crew-net) handles the **team**: other developers and their agents.
Its `/team` pane and pi-crew's `/crew` pane have separate state and band lines.

Workers launch with `CREW_NET_ROLE=worker`. When crew-net is installed, the lead speaks to the team for them.
The two plugins share [screen conventions](https://github.com/alexei-led/crew-net/blob/main/docs/design.md#shared-screen-with-pi-crew), not code.

## Update and troubleshoot

```sh
claude plugin marketplace update pi-crew
claude plugin update pi-crew@pi-crew
```

Restart or reload the plugin after updating.

| Symptom | Check or action |
| --- | --- |
| Tools or `/crew` missing | Use an interactive, mod-capable Claude Code session. Run `/reload-plugins`. |
| Spawn says "not running inside agterm" | Start Claude Code inside agterm. |
| Worker exits at launch | Check the worker terminal, executable, model id, and Pi credentials. |
| Bridge cannot import pi-intercom or tsx | Check the package path in settings. |
| Worker answers only in its own terminal | Ask the lead to remind it to send through intercom. |
| No report | Inspect `list` and the worker terminal. Busy workers do not trigger quiet alerts. |
| Bridge stopped or a report could not start a turn | Run `/reload-plugins` to reconnect and replay unacknowledged reports. |

See [architecture and limits](architecture.md) for restart behavior, retention, and trust boundaries.
