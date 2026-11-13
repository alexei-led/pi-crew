# Mixed crew observer

## Problem

A Claude lead can manage Pi workers and native Claude workers, but `/crew` observes only Pi's intercom records. The human needs one read-only roster with assignments, communication and reports, without changing either manager.

## Chosen approach

Use Claude's mod API for native workers. Keep Pi bridge contracts and delivery unchanged. Merge only presentation; do not add a provider registry, Pi extension, or Claude-private-file reader.

- Discover this conversation's subagents and teammates through `$.agent.list()`. Observe successful spawns, turns and message sends; periodically reconcile the cheap roster, never every worker's transcript.
- Scope native state to the actual Claude conversation ID. Ignore late asynchronous results from another conversation. A clear or resume must reset native selection and observations even when no new `session.start` fires.
- Separate agent ID, teammate address, display name, spawn generation and turn ID. Preserve identity across resumed turns; isolate confirmed replacement spawns.
- Keep native statuses. Waiting is not necessarily waiting on the lead, idle is not completed, and an absent roster entry is not proof of termination. Pane-hosted roster status is not verified liveness.
- Observe successful main-to-worker and worker-to-main sends once on `session.send`. Observe externally sourced teammate deliveries on `session.receive` only when the harness says they were not verified in this process. Do not combine mirrored send/receive events or deduplicate by text.
- Keep final turn reports distinct from explicit communication. A queued send is not a read receipt. Do not promise complete worker-to-worker communication.
- Offer an explicit, bounded, text-first conversation snapshot through `$.session.messages({ agentId })`. Display denials; never substitute the lead conversation. Do not implicitly switch the native UI view, because that redirects the next prompt.
- Retain bounded observations and freeze browsed history until Latest. Report gaps before observation began. Browsing never sends, acknowledges, changes tasks, injects context, or starts a model turn.

## Trade-offs

The API avoids undocumented transcript and inbox formats. Full pane-hosted conversations are unavailable. Captured communications are recent observations, not a complete archive or proof of work correctness. Worker text can contain private code; do not copy raw real transcripts into fixtures or release artifacts.

Pi already displays native Pi children, including Pi children using Claude models. Actual Claude CLI children launched by pi-subagents have common run status/results but are one-shot, stop-only external workers without native supervisor transport, steering or resume. This feature does not widen those capabilities.

## Open questions

Release acceptance must verify live message attribution and roster behavior on the tested Claude build. Unsupported host operations must fail visibly without affecting native work. Full pane-hosted history and universal cross-host observation are out of scope.

## Testing strategy

- Pure behavior: native status mapping, names/source collisions, missing roster entries, respawns, resumed turns, retention, repeated text and pinned snapshots.
- Mod integration: actual hook result passthrough, no observer management effects, broker independence, denied reads, out-of-order responses, conversation switches, terminal outcomes and bounded refresh.
- Live acceptance: use claude-ds rather than quota-limited Claude models. Run a Claude lead with real Pi and native Claude workers; verify both roster rows, assignments, messages, final reports, snapshots, scrolling and reload. Exercise Pi's existing mixed-runtime path separately where available.
- Run bridge/model tests, mod tests, strict typechecks and plugin validation. Update user/operator docs and release notes. Remove only probe-owned sessions, workers, directories and worktrees after verification and merge.
