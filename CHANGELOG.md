# Changelog

## [0.7.0]

### Summary

Observe native Claude workers alongside Pi workers in the read-only crew pane.

### Changes

- Separate Pi and Claude roster sections, even when workers share a name. Native rows preserve Claude's statuses and distinguish missing agents from confirmed termination.
- Show observed Claude assignments, lead/worker messages and final turn reports without changing either manager's delivery.
- Read an explicit, bounded conversation snapshot through the host API. Tool names are visible; thinking, tool arguments and outputs are not copied into the snapshot.
- Preserve pinned reading, isolate replacement spawns and conversation changes, and retain recent observations across plugin reloads.
- Keep Claude observation independent of the Pi broker. No private Claude files are parsed and no new Pi extension is required.

### Upgrade

Use a mod-capable Claude Code build with native agent APIs (tested on 2.1.323) and reload the plugin after updating. Keep using native Claude tools for Claude workers; pi-crew tools still manage Pi workers only.
Native observation is not a complete archive. Full pane-hosted conversations are unavailable through the host API, and mailbox sender claims remain unverified.
Existing Pi worker records and delivery behavior are unchanged.

[Compare v0.6.0...v0.7.0](https://github.com/alexei-led/pi-crew/compare/v0.6.0...v0.7.0)

## [0.6.0]

### Summary

The crew pane is now a read-only observer of the lead and its Pi workers.

### Changes

- Replace the messaging inbox, reply controls, and stop actions with an assignment overview and recent conversations.
- Browse history without clearing manager unread counts or acknowledging reports. New messages do not interrupt reading back.
- Show explicit message actors and recorded DONE check evidence. Legacy outgoing authors remain unknown.
- Retain up to 50 messages per worker by default, within the existing age/global limits. Configure the count with `PI_CREW_HISTORY_LIMIT`.
- Keep assignments separate from progress. The lead can label a new assignment with `send.task`.
- Separate respawned worker runs so their conversations do not mix.

### Upgrade

Reload the plugin after updating. Direct workers through agent terminals instead of pane replies or stop buttons.
Lead tools are unchanged except for optional `send.task`. Existing records without assignment metadata are shown without an inferred task.
Increasing history retention does not recover already-discarded messages.

[Compare v0.5.1...v0.6.0](https://github.com/alexei-led/pi-crew/compare/v0.5.1...v0.6.0)

## [0.5.1]

### Summary

pi-crew now keeps routine worker progress quiet and makes DONE verification more reliable.

### Changes

- Progress waits for the next prompt or worker turn. Questions, DONE reports, and quiet alerts still start a turn.
- Worker messages are quoted as information, not instructions. The crew band and pane share controls and visual conventions with crew-net.
- DONE reports are rechecked after bridge restarts. Failed git inspections no longer report a clean checkout.
- The README, user guide, and architecture docs now explain setup, worker controls, data retention, and trust limits.

[Compare v0.4.1...v0.5.1](https://github.com/alexei-led/pi-crew/compare/v0.4.1...v0.5.1)
