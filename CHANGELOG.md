# Changelog

## [0.5.1]

### Summary

pi-crew now keeps routine worker progress quiet and makes DONE verification more reliable.

### Changes

- Progress waits for the next prompt or worker turn. Questions, DONE reports, and quiet alerts still start a turn.
- Worker messages are quoted as information, not instructions. The crew band and pane share controls and visual conventions with crew-net.
- DONE reports are rechecked after bridge restarts. Failed git inspections no longer report a clean checkout.
- The README, user guide, and architecture docs now explain setup, worker controls, data retention, and trust limits.

[Compare v0.4.1...v0.5.1](https://github.com/alexei-led/pi-crew/compare/v0.4.1...v0.5.1)
