# Source layout

Grouped by feature: each folder holds its daemons, their pure decision
logic (`*_decisions.ts`, `*_plan.ts`), and tests (`*_test.ts`) side by side.
In the game, scripts keep these paths (e.g. `hacking/scheduler_daemon.js`).

- `boot.ts` - entry point; installs and `tools/finish_bitnode.js` reboot into it.
- `system/` - keeping everything running: bootstrap (low-RAM start), reloader,
  log rotation, supervisor/player snapshot, phase (`phase.ts`), config, logs,
  saved-state helpers, monitoring (time series), RPC (`rpc/`: protos + generated code).
- `hacking/` - the network daemon (root, snapshot, rank), scheduler (HWGW batching),
  backdoors, program buying, share; `workers/` are the scripts copied to servers.
- `factions/` - augmentations, installs, faction/company work, study, training plans.
- `gang/`, `sleeves/` - their daemons and decisions.
- `economy/` - Hacknet, purchased servers, stocks.
- `go/` - the IPvGO player: board rules (`go_engine.ts`), move and opponent choice, daemon.
- `tools/` - one-shot command-line tools (`status`, `monitor`, `set_config`, `kill`, ...).
- `claude/commands.txt` - commands queued for the reloader to run.

Design notes: `docs/design.md`.
