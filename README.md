# pi-crew

A Claude Code mod that makes a Claude Code session the lead of a crew of [Pi](https://github.com/badlogic/pi-mono) workers in [agterm](https://agterm.dev). Claude spawns workers, gives them tasks, and is woken by their reports and questions. Transport is [pi-intercom](https://github.com/nicobailon/pi-intercom), the local broker Pi already runs: to Pi, the lead is just another intercom session.

```
┌ agterm ───────────────────────────────┐
│ Claude Code (lead)   Pi worker 1 api  │      pi-intercom broker
│   mod ─ crew-bridge ──────────────────┼──▶  ~/.pi/agent/intercom/broker.sock
│                      Pi worker 2 web  │      ▲
│                        intercom ──────┼──────┘
└───────────────────────────────────────┘
```

## Install

```sh
claude plugin marketplace add alexei-led/pi-crew
claude plugin install pi-crew@pi-crew
```

Then `/reload-plugins` or start a new session. Update later with `claude plugin marketplace update pi-crew && claude plugin update pi-crew@pi-crew`.

Requirements:

- Claude Code with mods, running inside agterm (`agtermctl` on `PATH`).
- Pi with the pi-intercom extension under `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), and its bundled `tsx`.
- `pi-work` on `PATH` (or set `PI_CREW_PI_COMMAND`).

## Use

Ask Claude in plain words; the bundled skill tells it how to lead:

> spawn two pi workers: `api` in ~/src/app/api to add the /health endpoint, `web` in ~/src/app/web to show it on the status page. Group them as `app`.

Each worker opens in a new agterm session next to Claude's, gets a brief naming its lead, and starts on its task. When it reports, Claude gets a new turn:

```
◆ Worker 1 api asks
Answer with mcp__pi-crew__send to "api" replyTo "7f3c…".
intercom id …, cwd …, message 7f3c…

Should /health check the database too?
```

Claude answers, reviews finished work (`○ Worker 1 api reports done`), and gives the next task or stops the worker. The transcript keeps the full conversation.

### Checked reports and idle alerts

A worker ends a `DONE:` report with fields the bridge checks against git in the worker's directory:

```
DONE: verify.sh no longer needs .github/
head: 3f9c2e1d…
branch: fix/detach
tests: bin/test
rc: 0
logs: none
```

If the task changes files, the worker commits first. A task that changes nothing reports the current HEAD and the checks actually run with their rc. Use `tests: none` only if no checks ran. Progress reports are allowed and the worker keeps working after them. Each finished task or question gets exactly one final send, then the worker waits.

The turn then says `DONE checks passed`, or `DONE checks failed:` with what is wrong: a missing field, a non-zero `rc`, a HEAD or branch that differs from the claim, uncommitted changes, work on the default branch (unless spawned with `allowDefaultBranch: true`), or uncommitted changes in the main checkout when the worker runs in a linked worktree (edits that escaped it). The checks prove the claims, not the work: review the diff before you merge.

A worker on a task that sits idle on intercom, or drops off it, for 10 minutes with no message wakes Claude once, with the last 15 lines of its screen:

```
◇ Worker 2 slimdown is idle without a report
intercom id …, cwd …, message …
idle on intercom for 12m, last message 40m ago, with no Q: or DONE:.
```

It alerts again only after the worker sends a message or gets busy and goes idle again. Set `PI_CREW_IDLE_MIN` to change the threshold, `0` to turn it off. A worker that asked a question or reported done is waiting by design and does not alert.

### The band and the pane

The band above the prompt shows the crew at a glance. Click a part to open the pane there:

```
c: crew 3 · a: ◆ 1 api 4m: Should /health check the database too? · u: ✉ 2 new · ● 1 working · ○ 1 idle
```

Zero counts are hidden. The band prioritizes crew, question, unread, working, idle, then stopped. Each count uses words when they fit, then compact form (`●1`), then hides. The question clips the worker name before its text. The question stays at normal contrast in yellow and opens its worker’s thread. With several open questions, it shows their count before the oldest worker (`◆ 2 asks · 1 api 4m: …`, or `◆2 · 1 api…` when tight). Working is green, unread is cyan, and stopped is dim; glyphs and words carry the same meaning without color.

`/crew` opens the pane: who needs you, what each worker is doing, and its latest few messages. Claude Code places it: docked beside the transcript in the fullscreen layout from 110 columns, otherwise inline above the prompt. The main-screen layout (`CLAUDE_CODE_NO_FLICKER=0`, and tmux by default) always places it inline.

```
 1: Inbox ✉2 ◆1   2: Crew 3                              x: ×
 a: [all 3]  n: ◆ needs you 1  w: ● working 1
 i: ○ idle 1  s: ✕ stopped 0

 ◆ 1 api    2m ✉1 Should /health check the database too?
 ● 2 web   now ✉1 status page wired, tests running
 ○ 3 docs  40m    README updated

 1/2 tabs · a n w i s filter · Tab move · Enter activate · Esc/q: close
```

Select a worker for its detail:

```
 b: back                                                x: ×
 o: worker terminal  s: stop
 ● 2 web
 app · working · 12m
 ~/src/app/web · router/openai-work · last now · ✉ 1 new

 latest 3 of 8 · full text in the transcript  e: more
 you  3m
   use the shared Badge component
 ● web  now
   status page wired, tests running

 ┌ message 2 web · Enter sends ──────────────────────────────┐
 b back · e more · o terminal · s stop · Tab move · Enter activate · Esc/q: close
```

| Glyph | State |
| --- | --- |
| `◆` | asked a question, waiting for you |
| `●` | working |
| `○` | done or idle (neutral, not working green) |
| `✕` | stopped |
| `✉` | unread messages (`new` in the band) |
| `◇` | bridge alert: idle on a task without a report |

### Keys and mouse

Click any chip, row or action. With the band focused (`ctrl+x tab`), `c` opens Crew, `a` answers the oldest question, and `u` opens the inbox when unread is shown.

In the pane:

- `q`, `x` or `Esc`: close. The top-right `×` also closes.
- `1` / `2`: Inbox / Crew. `a` / `n` / `w` / `i` / `s`: all / needs you / working / idle / stopped.
- Tab moves focus; Enter activates the focused control. The first visible worker starts focused.
- Detail: `b` back (keeps tab/filter), `e` more/less messages, `d` expand/collapse a cut question, `o` worker terminal.
- `y` / `n`: send yes / send no. Type in the message field and press Enter to send; Claude hears about it with the worker's next report.
- Detail `s` arms stop (or forget for a stopped worker); `c` confirms. Stopping closes the session and ends current work. The cancel button (`v`) or another action disarms it. Confirmation never takes focus automatically.

Shortcuts do not apply while the message box has focus: keys type text, Enter sends, and Esc closes the pane.

Long worker names are clipped in narrow lists; detail actions stay on separate lines from the worker identity.

## Tools

| Tool | Use |
| --- | --- |
| `mcp__pi-crew__spawn` `{name, cwd, task?, group?, model?, allowDefaultBranch?}` | Start `pi-work` in a new agterm session. `model` defaults to `router/openai-work` (`PI_CREW_DEFAULT_MODEL`). With a task, a `cwd` on the default branch is refused unless `allowDefaultBranch` is set. |
| `mcp__pi-crew__send` `{to, text, replyTo?}` | Message a worker by name, or any session by full id, session name (any case) or a unique id prefix of 6+ characters. An ambiguous or unknown name fails and lists the live sessions. |
| `mcp__pi-crew__list` | The crew, one row per worker: state, `waitingOnLead`, unread, time since the last message, live intercom status with the time since it last turned busy or idle (no time when the bridge has only just seen it), context %, open question. Then the live intercom sessions. |
| `mcp__pi-crew__stop` `{name}` | Close a worker's session. Stop again to forget it. |

## How it works

- One `crew-bridge` process per agterm pane holds the lead's intercom identity. `/reload-plugins`, `/clear` and resume in that pane keep the same id, and reports that arrived meanwhile are replayed.
- A worker gets a fixed intercom id from the lead and its name, so a respawned worker keeps its address. It starts a question with `Q:` and a finished task with `DONE:`.
- The worker's launcher starts it in `cwd`, and its brief tells it to stay there. Pi does not enforce that: a model can still `cd` away, which the DONE checks catch.
- Idle alerts come from Pi's intercom presence (`idle`, `thinking`, `tool:…`), which also carries context %.
- The bridge loads the client from Pi's own pi-intercom install, so the wire protocol matches the running broker. Nothing is vendored.
- State lives in `~/.pi-crew/<pane>/` (mode 0700): workers, a short message log, unanswered reports, briefs. A state file the bridge cannot read is renamed to `<name>.bad-<timestamp>` and reported as an error, never overwritten.

Cleanup is automatic. The pane is for current work, not history:

| What | Kept |
| --- | --- |
| Messages per worker | the latest 10, at most 24 h |
| A stopped worker | 30 min, so its last report stays readable; then it and its messages go |
| A worker whose agterm session closed | marked stopped within seconds |
| Another pane's crew directory | removed after 7 days with no change |

## Limits

- One machine. The broker mailbox is in memory: a broker restart drops queued messages.
- A worker's model decides whether it follows the brief. Nudge a worker that answers only in its own pane with `send`.
- Nothing confines a worker to its directory; the brief asks and the DONE checks detect.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_CREW_IDLE_MIN` | `10` | Minutes a working worker may sit idle before Claude is woken; `0` turns the alert off. |
| `PI_CREW_DEFAULT_MODEL` | `router/openai-work` | Model for `spawn` without `model`. |
| `PI_CREW_PI_COMMAND` | `pi-work` | The Pi command a worker runs. |
| `PI_CREW_DIR` | `~/.pi-crew` | Where crew state lives. |

## Develop

```sh
bin/test                       # bridge and view logic (node --test with Pi's tsx)
bin/typecheck                  # mod, bridge and tests with TypeScript 7
claude plugin test .           # band and pane rendering
claude plugin validate .
```

`bin/typecheck` needs the mod to have loaded once, for `.claude-plugin/types`. The repo has no `package.json`: it
installs `typescript@7` and `@types/node` once into `${TMPDIR:-/tmp}/pi-crew-typecheck` (override with
`PI_CREW_TYPECHECK_DIR`) and needs npm and network on the first run only.

## License

MIT
