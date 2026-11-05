# pi-crew

A Claude Code mod that makes a Claude Code session the lead of a crew of [Pi](https://github.com/badlogic/pi-mono) workers running in [agterm](https://agterm.dev). The lead spawns workers, sends them tasks, and is woken by their reports. Transport is [pi-intercom](https://github.com/nicobailon/pi-intercom), the local broker Pi already runs.

```
Claude Code (lead) ── mod ── crew-bridge ──┐
                                           ├── pi-intercom broker (~/.pi/agent/intercom/broker.sock)
Pi worker (agterm session) ── intercom ────┘
```

## What it adds

| Surface | Use |
| --- | --- |
| `mcp__pi-crew__spawn` | Start `pi-work --model <profile>` in a new agterm session after the lead's, with a fixed intercom id and a brief that names the lead. Optional first task. |
| `mcp__pi-crew__send` | Message a worker by name, or any intercom session by id. `replyTo` answers a message that expects a reply. |
| `mcp__pi-crew__list` | Live intercom sessions and the crew. |
| `mcp__pi-crew__stop` | Close a worker's agterm session. |
| Wake-up | Each worker message starts a new turn in the lead session. |
| `/crew` | Pane with the roster and the message log. Status line shows live workers. |

## How it works

- One `crew-bridge` process per Claude session holds one intercom identity, derived from the Claude session id. It survives `/reload-plugins` with the same id, so the broker mailbox (24 h, in memory) delivers what arrived meanwhile.
- A worker gets `PI_INTERCOM_STABLE_ID` derived from the lead session and the worker name, so a respawned worker keeps its address.
- Workers report with `intercom({ action: "send", to: "<lead id>" })`, never `ask`: a Pi `ask` waits for a reply the lead sends with `replyTo`, which works, but `send` keeps workers from blocking.
- The bridge imports the client from Pi's own pi-intercom install, so the wire protocol always matches the running broker. No dependencies are vendored.
- Crew state lives in `~/.pi-crew/<session>/` (workers list, briefs, launch scripts, control socket, mode 0700/0600).

## Requirements

- Claude Code with mods (function hooks), running inside agterm.
- Pi with the pi-intercom extension installed under `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), and its bundled `tsx`.
- `pi-work` (or set `PI_CREW_PI_COMMAND`) and `agtermctl` on `PATH`.

## Install

```
claude plugin marketplace add alexei-led/pi-crew
claude plugin install pi-crew@pi-crew
```

Settings: `PI_CREW_DEFAULT_MODEL` (default `router/openai-work`), `PI_CREW_PI_COMMAND` (default `pi-work`).

## Limits

- One machine. The broker mailbox is in memory: a broker restart drops queued messages and open asks.
- A worker's model decides whether it follows the brief; a worker that answers only in its own pane can be nudged with `send`.
- agterm companion sessions (`--parent`) need a newer agterm app; workers are placed with `--after`.

## License

MIT
