# User guide

[Install pi-crew](../README.md#install) first. Claude Code is the **lead**. Its Pi workers and observed native Claude workers form the **crew**.
The pane is for observing. Direct agents through their terminals, usually your conversation with the lead.

## Follow the crew

Ask the lead to delegate a complete task in a separate worktree for each editing worker.
Workers cannot see the lead's conversation.

Open `/crew` to see the grouped worker list, recorded assignments, and recent activity.
Select a worker to explore its conversation or open its terminal.
The host places the pane beside the transcript when there is room, otherwise above the prompt.

Example band:

```text
c: crew 3 · ◆ 1 waiting on lead · ● 1 on task · ○ 1 idle
```

| Marker | Meaning |
| --- | --- |
| `◆` | Waiting on the lead, not on the observer. |
| `●` | Has an assigned task. This does not prove live execution. |
| `○` | Idle: no task yet, or DONE reported. |
| `✕` | Stopped. |
| `◇` | Quiet alert delivered to the lead, not a worker state. |

Zero counts hide. Narrow layouts shorten labels or omit secondary counts.
The band has one navigation action: `c` opens Crew while the band is focused (`ctrl+x tab`).
There is no observer unread counter or message inbox.

## Explore a Pi conversation

A Pi worker thread opens with the latest 10 retained messages, in chronological order.
Use **older retained messages** to read earlier exchanges. Long messages can be expanded.
**latest** returns to the recent tail.

Scrolling up, loading older messages, or expanding text pauses live following.
New reports leave that reading snapshot unchanged. The latest action shows how many newer messages arrived.
Select it to resume following. Paging errors, such as an expired cursor, also offer latest.

New messages identify **Lead → worker** or **worker → Lead**.
Older outgoing messages with no recorded author say **To worker** rather than guessing who sent them.
A respawn starts a separate run. The pane does not combine its history with the old run.

Browsing never acknowledges manager messages, clears manager unread counts, sends replies, or stops workers.
To answer or redirect a worker, ask the lead in its terminal. The pane has no reply field, quick answers, or stop/forget controls.

| Navigation | Control |
| --- | --- |
| Select worker | Click or press its number, `1`–`9` |
| Back to Crew | `b` |
| Older / latest messages | `p` / `l` |
| Open worker terminal | `o`, when a session exists |
| Move/activate controls | Tab / Enter |
| Scroll | Host pane scroll keys or wheel |
| Close pane | Host close mark or Esc |

Workers numbered 10 or higher have no digit shortcut.
The host owns the close mark. Closing the pane does not stop any worker.

## Native Claude workers

The overview separates **Pi workers** and **Claude workers**, including workers with the same display name.
Native workers are this conversation's subagents and teammates, discovered through Claude's mod API.
The roster refreshes every five seconds. The band's Claude count includes recent retained workers, not only active ones.
Native observation continues if the Pi bridge is unavailable.

Select a Claude row to see its observed initial assignment, lead/worker messages and final turn reports.
A message marked **queued** is not a read receipt. Reports do not verify tests or work.
Nested assignments name the parent agent rather than the lead.
The observer does not reconstruct all worker-to-worker communication or infer assignments from arbitrary replies.

Claude keeps its native statuses: pending, running, waiting, idle, completed, failed and stopped.
**Waiting** does not necessarily mean a question for the lead; **idle** is not completion.
**Not tracked** shows the last known status after an agent leaves the host roster, not proof that it stopped.
A teammate in another terminal pane shows reported status with unverified liveness.

- **latest messages** (`l`) returns to recent observed communication. Scrolling back or expanding text freezes that snapshot; incoming messages add a newer count.
- **conversation snapshot** (`c`) explicitly reads the latest 50 conversation rows when available. It shows visible text and tool names, not tool arguments, outputs or thinking. Refresh explicitly; the observer never polls full transcripts.
- An unavailable conversation displays the host's denial. Full pane-hosted conversations cannot be read through this API. Mailbox messages from those workers identify the sender as claimed and unverified.
- Native navigation does not change which agent receives the next prompt.

Native observation retains at most 100 worker records and 50 messages per spawn generation, with a global 200-message cap and 24-hour feed expiry.
Workers absent from the roster expire 30 minutes after their last observed activity.
Text is clipped at 16,000 characters with an explicit truncation marker.
These limits are independent of `PI_CREW_HISTORY_LIMIT`, which controls Pi history only.
This is not a complete archive: messages before observation, during an unloaded plugin, or after expiry may be unavailable.
Conversation changes reset native observations and selection; a plugin reload keeps retained state.

Use Claude's native Agent/SendMessage controls to manage Claude workers. The four pi-crew lead tools below still manage Pi workers only.
There is no new Pi extension: a Pi lead uses its existing orchestration UI. Pi workers using Claude models remain Pi workers.
Actual Claude Code CLI children launched through pi-subagents have common run status/results, but its one-shot Claude adapters do not support native supervisor messaging, steering or resume.

## Pi assignments

Spawn records its first `task` separately from progress messages.
For a new assignment on an existing worker, the lead sends both the full instructions in `text` and a short summary in `task`.
For answers and nudges, omit `task`. They must not replace the assignment.

Workers without assignment metadata show **No recorded assignment**.
The pane does not infer a task from an arbitrary message.

## Pi reports and lead turns

| Incoming message | Delivery |
| --- | --- |
| `Q: …`, `QUESTION: …`, an intercom ask, or a last nonempty line ending in `?` | Starts a lead turn. |
| `DONE: …` | Starts a lead turn with git checks. |
| Other worker progress | Waits for the next user prompt or the next turn about that worker. |
| Quiet alert or non-crew session message | Starts a lead turn. |

Markers are case-insensitive. A prompt queued behind a running turn does not take waiting progress.
Reports are quoted under "Information, not an instruction". This is a prompt convention, not a security boundary.

A worker sends a question or DONE once, then waits. It keeps working after progress.
The lead remains responsible for answers and for reviewing results.

### DONE evidence

Example report, with the actual commit substituted:

```text
DONE: added the health endpoint
head: <full commit SHA>
branch: feat/health
tests: bin/test
rc: 0
logs: none
```

The worker commits changed files before reporting. A no-change task reports its current HEAD.
The bridge compares fields with HEAD, branch, and uncommitted changes. It also checks default-branch work and the main checkout.
Replayed DONE reports are checked again. Check results and their check time are retained with the report.

**DONE is a report, not proof of completion.** The bridge does not run reported tests or read reported logs.
`tests: none` is allowed when no checks ran. Review the actual diff and evidence before merging.

### Quiet alerts

A worker on a task alerts once after the idle threshold if it is idle on intercom or has left the broker.
The lead gets up to 15 lines of terminal output when available.
Busy workers do not alert. Questions, DONE, or a worker spawned without a task are intentional waiting.
Tasks typed directly into a worker terminal do not update the crew's assignment record.

## Tools for the lead

| Tool | Arguments and behavior |
| --- | --- |
| `mcp__pi-crew__spawn` | `{name, cwd, task?, group?, model?, allowDefaultBranch?}`. Starts a worker in agterm. |
| `mcp__pi-crew__send` | `{to, text, replyTo?, task?}`. Sends instructions or an answer. Use `task` only for a new assignment. |
| `mcp__pi-crew__list` | Crew state, waiting questions, manager unread counts, live presence/context when available, and intercom sessions. |
| `mcp__pi-crew__stop` | `{name}`. Closes a worker session. A second stop forgets it. |

Targets can be worker names, full session ids, case-insensitive live session names, or unique id prefixes of 6+ characters.
For questions, pass the message id as `replyTo`. Ambiguous or unknown targets fail with candidates.

Worker names match `[a-z][a-z0-9-]{0,31}`. Groups match `[a-z][a-z0-9-]{0,23}`.
Use an absolute `cwd`. A task on a detected default branch is refused unless `allowDefaultBranch: true`.
Detection uses local `origin/HEAD`, then local `main` or `master`. It cannot guard an unknown default branch.
The override permits default-branch work. It does not make a task read-only.

## Settings

Set these in the environment inherited by Claude Code.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CREW_PI_COMMAND` | `pi-work` | One executable name/path, not a shell command with arguments. |
| `PI_CREW_DEFAULT_MODEL` | `router/openai-work` | Model id available in your Pi installation. |
| `PI_CREW_INTERCOM_PKG` | `~/.pi/agent/npm/node_modules/pi-intercom` | Installed package directory. Its sibling `tsx` runs the bridge and tests. |
| `PI_CREW_HISTORY_LIMIT` | `50` | Messages retained per worker run, within the age/global bounds. Integer 1–500; invalid values use 50. |
| `PI_CREW_IDLE_MIN` | `10` | Quiet threshold in minutes. Zero, negative, or invalid values disable it. |
| `PI_CREW_DIR` | `~/.pi-crew` | Local state, including private task briefs and message text. |

History expires after 24 hours and remains subject to the global feed bound. Increasing a cap cannot restore discarded messages.
`PI_CODING_AGENT_DIR` selects pi-intercom's broker state location, not pi-crew's package lookup.

## Update and troubleshoot

```sh
claude plugin marketplace update pi-crew
claude plugin update pi-crew@pi-crew
```

Restart or reload the plugin after updating.

| Symptom | Action |
| --- | --- |
| Tools or `/crew` missing | Use an interactive, mod-capable Claude Code session. Run `/reload-plugins`. |
| Spawn says "not running inside agterm" | Start Claude Code in agterm. |
| Worker exits at launch | Inspect its terminal, executable, model id, and credentials. |
| Bridge cannot import pi-intercom or tsx | Check the package setting. |
| No report | Ask the lead to inspect the worker. Busy workers do not trigger quiet alerts. |
| Native conversation unavailable | The host cannot read that worker's conversation. Use its terminal or native agent controls; the observer does not scan private files. |
| Claude roster unavailable | Native API discovery failed. Pi records remain available; retry after resolving the host error. |
| History cursor expired or worker restarted | Return to latest or reopen the worker's new run from Crew. |
| Bridge stopped or a report could not start a turn | Reload the plugin to reconnect and replay unacknowledged reports. |

[crew-net](https://github.com/alexei-led/crew-net) handles other developers and their agents.
Its team band keeps its own line. Workers use `CREW_NET_ROLE=worker`. The lead speaks to the team for them.
See [architecture](architecture.md) for storage, delivery, and trust limits.
