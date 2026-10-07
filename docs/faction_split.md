# Splitting the faction daemon into services

**Why.** The faction daemon costs 100.8 GB: the game charges every function a script references,
anywhere in its imports. A fresh BitNode starts with a 32 GB home, and the early hacked servers are
16–64 GB. So the daemon waited for a purchased 128 GB server (`daemons-0`, $7.9M). In BN12 run 3 that
was 38 minutes (18:19–18:57) with no faction work, invites or karma decisions. Split into pieces of
32 GB or less, it can start on early hacked servers instead.

**Shape.** The decisions stay in one place, the faction daemon, now a planner. The game calls move into
four services, each one script on its own port, defined by a `.proto`. Ports are global, so the
planner can call a service on any server. Every call carries a deadline (`system/deadline.ts`).

| Service | Game functions | Estimated RAM |
|---|---|---|
| `FactionInfoService` | Augmentation catalog (factions, price, rep requirement, prerequisites, stats), owned and installed, faction rep and favor, favor to donate, company rep | ~31 GB |
| `FactionWorkService` | Invitations, joining, invite requirements, current work, faction work types, faction and company work, jobs, travel, gym, stop | ~29 GB |
| `CrimeService` | Crime stats and chances, commit crime | ~17 GB |
| `AugmentPurchaseService` | Buy, donate, home RAM upgrade and cost, stock positions held, install | ~27 GB |
| Planner (`faction_daemon.ts`) | Player, formulas, gang membership, finish launch; RPC clients | ~12 GB |

**Rules.**
- **Services are dumb.** No decisions, no config and no state files: each request is one or a few
  game calls. Nothing to sync with home, so any server works.
- **The planner snapshots, then acts.** Each tick starts by fetching what it needs from the services
  (one call per service). The existing decision code runs on that data, then actions go out as calls.
  If a service doesn't answer by the deadline, the tick is skipped, never half-run.
- **The planner imports nothing that references a heavy function.** That includes modules it only uses
  for a constant: the game charges the whole module.

**Placement (boot).** In priority order:
1. Home, if it has room.
2. Otherwise the smallest rooted server with room. These hosts are recorded in `/var/daemon_hosts.txt`,
   so the scheduler keeps its workers off them and the reloader finds and restarts them there.
3. `daemons-0` as the last resort.

After an install, everything starts on home again once it fits.

**Landing.** Built on branch `faction-split` in a separate worktree, so the live game (which syncs
from the main tree) never sees a half-done split. It lands at the start of BN12 run 5, so run 4
measures the earlier changes on their own. Run 5's `faction_daemon` milestone then measures this one
against run 4.
