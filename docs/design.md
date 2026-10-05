# Server Metadata Service

`SupervisorService` (`server_metadata.proto`) is the authoritative store of
every server the player knows about. `crawl_servers.ts` observes raw facts
about the network and pushes them in; `supervisor.ts` holds the in-RAM/disk
state and computes each server's current lifecycle on read, so nothing
downstream (target selection, the rooter, a future hack scheduler) has to
re-derive it. `supervisor.ts` also dispatches the one-shot jobs that act on
that lifecycle (`rooter.ts`, `target_selector.ts`) — see "Dispatch" below.

## Two independent axes, not one lifecycle chain

Earlier versions of this service modeled a server's lifecycle as a single
`ServerStatus` enum (`DISCOVERED → ROOTABLE → ROOTED → HAS_MONEY →
ELIGIBLE`). That's not how the game actually works: root access and
hackability are two unrelated gates, and money is a third, static fact.
Bitburner's own docs for `ns.nuke()` are explicit about this: *"the
server's required hacking level is not a requirement of nuking."*

### `rootStatus`: `UNROOTABLE | ROOTABLE | ROOTED`

| Value | Persisted? | Set by | Meaning |
| --- | --- | --- | --- |
| `UNROOTABLE` | Yes | `crawl_servers.ts` | Known to exist, not rooted, not (yet) enough ports owned. |
| `ROOTABLE` | No — computed live | `computeRootStatus` / `isRootable` | Not rooted, but enough port-openers are owned to nuke it right now. |
| `ROOTED` | Yes | `crawl_servers.ts` (initial), `rooter.ts` (transition) | Admin access obtained — permanent, real game state (`ns.getServer().hasAdminRights`). |

Only `UNROOTABLE` and `ROOTED` are ever written to disk — the two facts a
crawl (or the rooter) can actually observe. `ROOTABLE` is a refinement,
computed fresh from `portOpenersOwned` every time `ListServers` is called,
so it can never go stale.

**`UNROOTABLE` → `ROOTABLE`** advances (in the computed sense) once the
player owns at least as many port-opener programs as the server requires:
`hacking.requirements.ports <= portOpenersOwned`. `portOpenersOwned` comes
from `player.ts` counting which of `BruteSSH.exe` / `FTPCrack.exe` /
`relaySMTP.exe` / `HTTPWorm.exe` / `SQLInject.exe` exist on `home`.

**`ROOTABLE` → `ROOTED`** is handled by `rooter.ts` (dispatched by
`supervisor.ts`, see below): opens every port-opener program the player
owns against the server, calls `ns.nuke()`, and — only if `nuke()` actually
returned `true` — writes the transition back via
`PatchMetadata({ server: { hostname, rootStatus: RootStatus.ROOTED } })`.
A failed nuke (e.g. a stale `ROOTABLE` classification racing a concurrent
crawl) leaves the server untouched rather than incorrectly marking it
`ROOTED`; it just gets picked up again on the next pass. `rooter.ts` never
computes rootability itself — it only ever reads `rootStatus === ROOTABLE`
off `ListServers` and acts on it. Once the `PatchMetadata` write lands, the
server stops being reported as `ROOTABLE` on the next call, since
`computeRootStatus` now sees a `ROOTED` base fact instead of `UNROOTABLE` —
that's what prevents a double-nuke, not a separate "already ran" flag.

### `hackStatus`: `UNHACKABLE | HACKABLE`

Purely a live comparison of the player's current hacking level against a
server's fixed `hacking.requirements.level` (`computeHackStatus`) — never
stored, since nothing *does* anything to cause this transition, unlike
rooting. It's independent of `rootStatus` entirely: the comparison is valid
and computable for a server that isn't rooted yet, exactly as validly as
for one that is. It only becomes practically relevant once a server is also
`ROOTED`, which is what `isEligible` (below) captures.

### Money: not a state at all

`maxMoney > 0` is checked inline wherever needed (`hasMoney`), not modeled
as a named state — it's a permanent, static fact fixed the moment a server
is first crawled, not a threshold that resolves with player progress. A
`ROOTED` server with `maxMoney === 0` will never be worth attacking, no
matter what else changes.

### `isEligible`: the combined predicate

`isEligible(server, hackingLevel) = hasMoney(server) && computeHackStatus(server, hackingLevel) === HACKABLE`
(which also requires `rootStatus === ROOTED`, since `hasMoney` checks that).
This is what `ListServers({ eligibleOnly: true })` filters on, and what
`target_selector.ts` ranks over. It's not a fourth axis — it's the AND of
the two independent ones plus the static money fact, computed fresh on
every call.

### `kind`: what a server *is*, not the same thing as `purchasedByPlayer`

`ns`'s own `Server.purchasedByPlayer` is one boolean covering three unrelated
cases — its own doc comment: *"e.g., home, cloud servers, hacknet servers"*.
That's not specific enough for `purchased_server_daemon.ts` (below), which
needs to tell "a real `ns.cloud` server" apart from `home` or a Hacknet
server — `ns.cloud.upgradeServer`/`getServerUpgradeCost` only operate on
servers `ns.cloud` itself created, not the other two. Rather than bolt a
second, overlapping field onto `Metadata` (a refinement of
`purchasedByPlayer` for three of its four values is just two sources of
truth that can drift), `Metadata.kind` (`ServerKind`: `NPC` / `HOME` /
`HACKNET` / `PURCHASED`) **replaces** it outright:

```ts
function classifyServerKind(hostname, purchasedByPlayer) {
  if (hostname === "home") return HOME;
  if (/^hacknet-server-\d+$/.test(hostname)) return HACKNET;
  return purchasedByPlayer ? PURCHASED : NPC;
}
```

Computed once, in `crawl_servers.ts`'s `toServerMetadata` (the single place
every `Server` → `Metadata` conversion happens, whether from a real crawl or
`purchased_server_daemon.ts`'s own `UpdateMetadata` push after buying a
server) — Bitburner gives no more direct signal than the boolean plus the
hostname, so this falls back to the two facts available: the fixed `"home"`
hostname, and Hacknet Servers' name always being `hacknet-server-<N>`
(game-generated, not player-renameable, unlike cloud servers which support
`ns.cloud.renameServer`).

## Dispatch: who launches `rooter.ts` and `target_selector.ts`, and when

Lives in `supervisor.ts`, as a third `addBackgroundTask` (alongside the
existing player-context refresh and flush tasks), driven by pure functions
in `dispatch.ts`. This is *not* `player.ts`'s job — `player.ts` only ever
polls `ns.getPlayer()`/owned programs and writes the snapshot to disk,
nothing else. Folding dispatch into `supervisor.ts` instead of a standalone
watcher daemon saves ~2.6 GB of permanent RAM (a new daemon would pay its
own 1.6 GB base cost plus `ns.run`/`ns.scriptRunning`, whereas supervisor
already holds `hackingLevel`/`portOpenersOwned` in RAM from its existing
background task, so the marginal cost is just `ns.run()` ≈ 1 GB).

Three independent triggers, each firing at most once per background-task
tick (`DISPATCH_CHECK_INTERVAL_MS`, 5s — no point checking faster than
`player.ts` itself can produce a new reading):

1. **Hacking level changed** → launch `target_selector.js` (unforced). A
   previously out-of-reach `ROOTED` server may now be within hacking
   level.
2. **`portOpenersOwned` changed** → launch `rooter.js`. A previously
   `UNROOTABLE` server may now be `ROOTABLE`.
3. **The rooter's completion marker changed** → launch `target_selector.js`
   *forced* (`--force`, via `dispatch.FORCE_ARG`). The rooter may have just
   rooted a server that's already within hacking-level reach —
   `target_selector.ts`'s own `shouldRecompute` only compares stored vs.
   current hacking level, so it can't see this on its own; forcing bypasses
   that check. Guarded so a hacking-level change and a rooter completion in
   the same tick don't queue `target_selector.js` twice.

The completion marker (trigger 3) is a small file `rooter.ts` writes as its
last action (`dispatch.ROOTER_MARKER_PATH`), polled with `ns.read()`
instead of `ns.scriptRunning()` — both would work, but `read()` is 0 GB and
`scriptRunning()` is 1 GB, and this check runs forever inside supervisor
rather than once inside a one-shot script like `boot.ts`'s equivalent
`launchAndWait` pattern (where paying that 1 GB once is a non-issue).

## `PlayerService`: player context over RPC

`player_metadata.proto` defines a second service, `PlayerService`, with
two RPCs. `GetPlayerMetadata` returns `hackingLevel`/`portOpenersOwned`
(what anything here actually consumes today) plus the rest of
`ns.getPlayer().skills` (`strength`, `defense`, `dexterity`, `agility`,
`charisma`, `intelligence`), `singularityAvailable`, `money` (added for
`hacknet_daemon.ts` — see below), and `gangAvailable` (added for
`gang_daemon.ts` — an independent capability gated by Source-File 2, not
4, so it's its own field rather than reusing `singularityAvailable`) —
still not a full mirror of Bitburner's `Player` object (no `karma`,
`jobs`, `factions`, `mults`, ...), extended only as real consumers need
more. `PatchPlayerMetadata` (same "ignore explicitly-undefined fields"
merge semantics as `SupervisorService`'s `PatchMetadata`, no key needed
since there's only ever one player) lets a one-shot script push a fact
into player state once — `detect_capabilities.ts` is the only place that
calls the expensive `ns.getResetInfo()`, once, and patches both
`singularityAvailable` and `gangAvailable` in via this RPC in the same
call, rather than every consumer re-deriving them. `SupervisorState.player`
holds this directly as the generated `PlayerMetadata` type rather than
duplicating its fields by hand — the background refresh task below patches
it in place via `applyDefined` (the same helper `PatchPlayerMetadata`
uses), and `createPlayerHandlers` just returns it as-is for
`GetPlayerMetadata`.

Unlike `hackingLevel`/`portOpenersOwned` (re-derived from `player.ts`'s
snapshot every tick regardless of restarts), a `PatchPlayerMetadata` call
has no other source to recover from if `supervisor.js` restarts — nothing
else would ever re-set `singularityAvailable`. So `PatchPlayerMetadata`
marks `state.playerStateDirty`, and `flush()` persists `state.player` to
its own file (`playerStatePath`, `/var/supervisor/player_state.txt` by
default — distinct from `player.ts`'s `playerInfoPath`, which supervisor
only ever reads, never owns) whenever that's set, the same "mark dirty,
flush persists" shape already used for `listDirty`. `main()` loads it back
via `loadPlayerStateFromDisk` before serving, mirroring
`loadStateFromDisk` for server metadata. `boot.ts` used to skip
`detect_capabilities.js` once these flags were cached. It now runs the detector every boot,
because entering a new BitNode is exactly when Source-Files, and so these flags, change.

**BitNode facts: `/var/bitnode/current.txt` (`bitnode_info.ts`).** The detector also records the
node, `lastNodeReset`, owned Source-Files and, with SF5 or in BitNode 5,
`ns.getBitNodeMultipliers()`. Other scripts read it for 0 GB instead of paying the multipliers
call themselves. Uses so far:
- `skillMultiplier` (`skill_progress.ts`) computes a skill's exact level multiplier as the
  player's `mults` × the BitNode's `…LevelMultiplier`, used by `skill_eta`, the study daemon's
  route choice and the GROW_STATS install check. It falls back to solving the multiplier from
  level and experience when the file has no multipliers.
- `bitnode_status_report` uses `DaedalusAugsRequirement` instead of assuming 30.

The file is versioned (`v`), rewritten each boot, and kept out of `WIPE_PREFIXES`. It is the
"current BitNode" half of the BitNode record planned in the design review; the append-only
history is not built yet.

It's served by `supervisor.ts`'s
*same* RPC server as `SupervisorService`, registered onto the same port
(`server.registerService` already supports multiple named services on one
port, the same mechanism a single `.proto` file with several `service`
blocks uses — this just does it across two files instead of one).
`PlayerService`'s own auto-assigned port in `port_registry.json` goes
unused; callers must construct
`NewPlayerServiceClient(ns, server_metadata_pb.SupervisorServicePort)`
explicitly rather than relying on the default.

This doesn't replace `player.ts` writing its snapshot to disk, or
supervisor's own 10ms internal refresh reading that file directly (both
stay — a direct file read is free and faster than an RPC round trip for
supervisor's own use). It's an additional path for *other* scripts to get
current player context without paying for their own `ns.getPlayer()` call
(0.5 GB) or coupling to the raw file's path/format.

## Cold start (`boot.ts`)

**Low-RAM startup: `system/bootstrap/bootstrap.ts`.** The full system (supervisor RPC, scheduler, faction daemon, …)
is built for a big home. When home RAM is below `requiredHomeRam`, boot runs `system/bootstrap/bootstrap.js`
*instead* of anything else. `requiredHomeRam` is the summed `getScriptRam` of `CORE_SCRIPTS` plus
a 16 GB margin (`system/bootstrap/plan.ts`), so it follows the code rather than
being a fixed number. Boot only does this when the supervisor isn't already running: a boot
re-run after a RAM upgrade must not start bootstrap beside the full system.

Bootstrap uses no RPC, no generated code and no config, just direct calls (~15 GB, mostly the
singularity crime call). Every 10s it:
1. **Commits a crime** (Mug) while the player is idle. That's the only income that works at
   hacking level ~1, and a fresh BN10 sat at −$80k without it.
2. **Roots** everything the owned port openers allow.
3. **Runs `system/bootstrap/bootstrap_worker.js`** on every rooted server and on spare home RAM. It's a
   self-balancing weaken/grow/hack loop, about 2.4 GB per thread, aimed at the richest rooted
   server needing at most half your hacking level (`pickBootstrapTarget`).
4. **Hands off to the shopper** once cash covers TOR, an unowned port opener or the next home RAM
   upgrade (`shouldHandOffToShopper`). It stops its workers, runs `program_shopper.js --once`, and
   exits. The shopper spends all cash (as many RAM upgrades as it can), runs `boot.js`, and exits.
   Boot then picks bootstrap again or, once home is big enough, the full system. The purchase calls
   (7 GB) live only in the shopper, so bootstrap has more room for workers, and the two never
   compete for RAM. The player's crime continues across the switch.
5. **Hands back:** once home fits the core, it stops its workers, runs `boot.js`, and exits.

**State that must not cross a BitNode.** `/var` survives a BitNode change. `gang_daemon.ts`'s
`/var/gang_state.txt` now records the BitNode it belongs to (`nodeReset`, from
`/var/bitnode/current.txt`) and starts fresh in another one (`stateForNode`). Before this, BN9's
12-member count met BN10's new gang, `detectCasualties` counted the gap as 12 deaths, and the
stand-down disabled territory warfare.

**Launch order is priority order.** A fresh BitNode starts with a small home, and whatever launches
last just doesn't fit. After the one-shots and the capability detector, boot launches: the scheduler
(income), the program shopper, the faction and gang daemons, Hacknet, study, backdoor, then the
stock, purchased-server, monitoring and share daemons. The first BN10 boot had started study and
backdoor ahead of the scheduler, so nothing earned money.
It's **strict**: once one doesn't fit, nothing after it is launched. Otherwise a smaller,
lower-priority daemon takes the RAM the one that didn't fit needs. In BN10 the backdoor daemon took
the program shopper's RAM, so nothing bought RAM or programs. The program shopper re-runs boot after
each home RAM upgrade, which carries on down the list.

**Paid training needs cash.** The study daemon and the faction daemon's gym workouts first check
`canAffordTraining` (`study_decisions.ts`): cash must cover 10 minutes of the formula's cost, or
$1B without Formulas.exe. A workout already running is stopped if you can't afford it. Invite
pursuit also waits until combat is all that's left of an invite (`onlyCombatLeft`). On that first
BN10 boot, the study daemon, still set to BN9's GROW_STATS, had run cash negative in ZB's
Algorithms class.

The change-triggered dispatch above can't cover the very first observation
— `changed()` requires a *previous* reading to compare against, and there
isn't one at boot. So `boot.ts` still explicitly runs
`crawl_servers.js → rooter.js → target_selector.js` once, in that order, as
prerequisites for each other, independent of the background-task watcher.

## HWGW batching: acting on `target_selector.ts`'s ranking

`isEligible`/`target_selector.ts` answer "which server is currently most
worth attacking"; `scheduler_daemon.ts` is what acts on it — a proper
timed HWGW batcher, not a naive weaken/grow/hack loop (a single-process
loop is stable but wastes throughput, sitting idle on two of the three
actions at a time; see `hwgw.ts` for the delay-scheduling math this is
built on). Its RPC surface is defined in `scheduler.proto` — note the
daemon file is `scheduler_daemon.ts`, not `scheduler.ts`, since the
generator always writes a proto's client to `<package>.ts` in the same
directory and a same-named daemon file would collide with it (the same
reason `SupervisorService` lives in `supervisor.ts` rather than
`server_metadata.ts`).

- **`hack_worker.ts`/`grow_worker.ts`/`weaken_worker.ts`** — three
  separate minimal scripts (not one combined worker with an action
  switch), each just `await ns.{hack,grow,weaken}(target, {
  additionalMsec })` from `ns.args`. Kept separate because Bitburner's RAM
  cost is static per script: a combined script would cost ~2.0 GB
  (referencing all three functions) regardless of which branch runs,
  vs. ~1.7–1.75 GB each separately — a delta that multiplies by thread
  count.
- **`hackFraction` scales itself** (`autoHackFraction`, default on; `nextHackFraction`). Once per
  interval (≥1 minute and ≥1 weaken time, so a change has shown up in RAM use), the scheduler
  measures its worker hosts' RAM use. Below `targetUtilization` (0.85) with every batch fitting, it
  raises the fraction 25%. When batches didn't fit or use is above 95%, it lowers it 15%. It stays
  within 1% to `maxHackFraction` (0.9). The config's `hackFraction` is only the starting value; the
  live one is in `/var/scheduler_state.txt`, and `tools/status.js` shows it. In BN10 a fixed 5% had
  left half the fleet idle: raising it to 25% by hand took hacking income from $447M to $2.9B/min.
- **Security estimates never pass the target.** `growthAnalyzeSecurity(threads, host)` limits the
  increase to the threads needed to reach max money, and batches are planned *at* max money, so it
  returned 0. Every batch fired with no second weaken (`/W0` in the logs), security climbed, and the
  target drained. The scheduler calls `growthAnalyzeSecurity(threads)` and
  `hackAnalyzeSecurity(threads)` without a host.
- **A drifted target is re-prepped.** When a batch can't be sized (`hackAnalyzeThreads` −1) and
  the target is off its min-security/max-money baseline (`decidePrepAction`), the scheduler runs
  `prep` again. Prep used to run only on retarget, so a drained target stayed unbatchable forever:
  BN10's phantasy logged "not hackable" every tick with zero hacking running. A −1 at baseline
  (e.g. hacking level too low) still just warns and skips.
- **Delays are never negative** (`computeBatchPlan`). The hack delay is
  `weakenTime − spacingMs − hackTime` (= `3·hackTime − spacingMs`), which goes negative once
  `hackTime` drops below `spacingMs / 3`. That's reachable at high hacking level against easy
  targets, and `ns.hack` throws "additionalMsec must be non-negative". Every delay is shifted later
  by the same amount, keeping completion order and spacing unchanged.
- **Worker hosts: `home` and Hacknet servers reserved, with an early-game
  home fallback.** Hack/grow/weaken threads run on rooted servers other
  than `home` and `ServerKind.HACKNET` hosts (`listWorkerHosts`, via
  `ListServers` — purchased/`ns.cloud` servers count once bought). Hacknet
  servers are excluded because `ns.formulas.hacknetServers.hashGainRate`
  takes `ramUsed` as an input — running HWGW scripts on one measurably cuts
  its own hash output, undermining the entire point of
  `purchased_server_daemon.ts`'s counterpart, `hacknet_daemon.ts` (see
  below). `home` is included beyond a reserve (`homeWorkerRam`, `hwgw.ts`). Below
  `SchedulerConfig.homeFallbackHackingLevel` (default 50) the reserve is `homeReservedRamGb`
  (default 5), since early on home may be the only real RAM. Past that level it's the largest of
  `homeReservedRamGb`, 10% of home, and 64 GB: a small home stays free for the daemons, and a big
  one works. Home used to revert to fully reserved past level 50. But home RAM survives installs
  and purchased servers don't, so BN10's second run had about 16 TB of home idle after an install
  while prep crawled on 56 threads elsewhere and hacking earned $0. hackFraction auto-scaling
  counts home's worker share in its utilization. Both config values are live-patchable via
  `PatchSchedulerConfig`.
  `hack`/`grow`/`weaken` don't need to run *from* the target or from the
  same host as each other, so `allocateAcrossHosts` (`hwgw.ts`) places each
  of a batch's four actions independently, **round-robin** across live
  per-host free RAM (not a stale crawled snapshot, since other things could
  be running there) — one thread per host-with-room per pass, cycling
  until the full count is placed, rather than draining the biggest host
  first. This spreads a batch across the whole eligible fleet instead of
  concentrating it on the fewest/biggest hosts (a real problem in
  practice — a target's batch fitting entirely on one or two big hosts
  left everything else idle even with plenty of rooted/purchased capacity
  to spare). It's still scoped to whatever the batch's thread count
  actually needs — a 5-thread request only ever touches ~5 hosts, it
  doesn't manufacture extra work to keep every host busy regardless of
  batch size, that's a separate lever (`hackFraction`/batch sizing) not
  addressed here. If *any* of the four actions can't be placed anywhere
  even after exhausting every host's capacity, the whole batch is skipped
  rather than firing a partial one, and the next tick retries (logged,
  with the GB needed vs. available, instead of failing silently).
  `ensureWorkersDeployed` `ns.scp`s the three worker scripts to a host the
  first time it's used (`ns.exec` requires the script already present on
  the destination — it doesn't copy for you;
  a no-op on `home`, which already has them).
- **`scheduler_daemon.ts`** — prep phase (weakens/grows the target to
  min-security/max-money, since batch math is only valid from that
  baseline, using whichever worker host currently has the most free RAM)
  then a batch loop: each tick, compute a fresh `BatchPlan` against live
  security/money and try to place it across the worker-host pool. Retargets
  from `target_selector.ts`'s `weights.txt` (or
  `SchedulerConfig.targetOverride`) each tick. `boot.ts` launches it
  *last*, after every bootstrap-critical one-shot script — at ~8.6 GB
  (dominated by the `*Analyze*` functions), launching it eagerly alongside
  `supervisor.js`/`player.js`/`log_rotator.js` risked starving
  `crawl_servers.js`/`rooter.js` of the RAM they need to launch at all on a
  RAM-constrained `home`, breaking the entire rooting pipeline rather than
  just delaying the scheduler.
- **`SchedulerService`** (`scheduler.proto`) — `GetSchedulerConfig`/
  `PatchSchedulerConfig`, same `Get*`/`Patch*` shape as `PlayerService`,
  live-reconfigurable without restarting `scheduler_daemon.js`
  (`approach`, `hackFraction`, `spacingMs`, `targetOverride`). Unlike
  `PlayerService`, this runs on its *own* port (`SchedulerServicePort`) —
  `scheduler_daemon.ts` is its own process, not folded into
  `supervisor.ts`, so it can't ride on `SupervisorServicePort` the way a
  same-process service can. `Approach.GROW_STATS`/`CRIME` are defined as
  extension points (the schema for a future "what is home's effort going
  toward" mode switch) but not implemented — `HACK` and `STOCK_TARGETING`
  (see "Stock-targeting mode" below) are the two that do anything.
  **Persisted to `/etc/scheduler.txt`** via `loadJsonConfig`: the daemon
  re-reads it every tick (hand-edits take effect within ~1s, same as every
  other daemon's config), and `PatchSchedulerConfig` writes the merged
  config back through an injected `onConfigChanged` callback (keeps the
  handlers `ns`-free and testable). It used to be in-memory only, so any
  restart silently reverted e.g. `STOCK_TARGETING` back to `HACK`.
  `approach` is stored as its numeric enum value — use
  `tools/set_scheduler_approach.js` for the readable way to change it.

## Program purchasing: `ns.singularity`, gated by Source-File 4

**Home RAM and Formulas.exe too.** After TOR and the port openers, `hacking/program_shopper.ts`
upgrades home RAM whenever the next upgrade costs at most half the cash above the savings target
(`shouldUpgradeHomeRam`, so it never undercuts something being saved for). After each upgrade it
re-runs `boot.js`, which launches whatever didn't fit before. It then buys Formulas.exe once
affordable. Nothing bought home RAM before this. In a fresh BitNode home is small: the first BN10
boot couldn't fit the scheduler, and every sleeve function costs 4 GB. Upgrades survive installs,
and only a new BitNode resets them.

Buying port-opener programs (`ns.singularity.purchaseTor`/
`purchaseProgram`) requires Source-File 4 outside BitNode 4, and costs
2–32 GB *per function* merely by being referenced in a script (16×/4×/1×
multiplier by SF4 level) — regardless of whether the code path actually
runs, since Bitburner's RAM cost is static per script. Two-script split so
that cost is never paid when it can't be used:

- **`detect_capabilities.ts`** — the only place that calls
  `ns.getResetInfo()`; computes `singularityAvailable` and
  `PatchPlayerMetadata`s it (see above for why that's durable, not just
  in-memory).
- **`hacking/program_shopper.ts`** — one of three places that reference
  `ns.singularity.*` (along with `backdoor_daemon.ts`/`faction_daemon.ts`
  below), each kept fully isolated so its cost can never leak into
  `supervisor.ts`/`scheduler_daemon.ts`'s own footprint. `boot.ts` only
  launches it when `singularityAvailable` is true; a fixed 30s poll loop
  (not event-triggered — purchasing is gated by *money*, not hacking
  level, and SF4 ownership can't change mid-session) calls `purchaseTor()`
  (idempotent) then buys whichever of the five port-openers it can
  currently afford.

`player.ts`'s existing `ns.fileExists` detection of owned programs is
unaffected either way — that's how `portOpenersOwned` gets tracked
regardless of whether a program arrived via `program_shopper.ts` or a
manual purchase.

## Hacknet manager: `hacknet_daemon.ts`, BitNode-agnostic by construction

**Phases** (`nodePolicy`, `hashPriorityFor`). Hacknet money doesn't matter next to gang income in
the trillions, and BN10 halves it too, so the Hacknet is worth its hashes: gym and study speed
for invites, and upgrades to the scheduler's target.
- **During AUGMENTS' install loop,** nothing is bought. An install is minutes away and wipes the
  Hacknet. The loop is published by `faction_daemon.ts` in `/var/install_loop.txt`
  (`installLoopActive`).
- **Otherwise,** any node, upgrade or cache costing at most `incomeBudgetMinutes` (10) of income
  is bought. This replaces the `maxPaybackHours` money test, which valued hashes at Sell for
  Money prices and kept the Hacknet tiny. The payback test still applies without monitoring data.
- **Hashes go to training.** Improve Gym Training or Improve Studying goes first while the player
  trains. That covers `study_daemon.ts`'s sessions and also the faction daemon's gym work for an
  invite (`gymTraining` in `/var/faction_reps.txt`), and sleeves at the gym (a `gym` goal in
  `/var/sleeves.txt`, since the hash bonus multiplies sleeve gym gains too). Otherwise the
  configured order applies. Both
  multipliers last until the next install, so buying them while idle pays off at the next
  session.
- **Overflow** past `hashDrainAboveFraction` goes to `overflowHashUpgrade` (Increase Maximum Money; it was Reduce Minimum Security until income became capped by max money
  on the scheduler's target), not Sell for Money. Batch times scale with security, so it means
  more hacking exp, where $1M per purchase is nothing next to the gang. It falls back to
  `hashDrainUpgrade` when there's no target. An earlier version spent idle hashes on Increase
  Maximum Money first. That only raises hacking money, which doesn't matter here, and it took the
  hashes the training upgrades needed.
- `/var/hacknet_status.txt` feeds the hacknet line in `tools/status.js`.

Grows the Hacknet Node/Server fleet and spends hashes, without any
BitNode-specific branching. `ns.hacknet.purchaseNode()`/`upgradeLevel()`/
`upgradeRam()`/`upgradeCore()` behave identically whether a node is a
plain Hacknet Node (produces money directly — true in most BitNodes) or a
Hacknet Server (produces hashes — BN9/BN10/SF9); only the hash-spending
half of the API (`numHashes`/`spendHashes`/`hashCost`/`upgradeCache`) is
Server-specific, and it's naturally gated behind
`ns.hacknet.hashCapacity() > 0` (zero outside a Hacknet-Server context).
So the daemon always runs, everywhere, and just does whatever's currently
possible — no explicit "am I in BN9" check anywhere.

**No proto, no RPC service** — deliberately, unlike every other daemon in
this codebase. `HacknetConfig` has no consumer except the daemon itself
(unlike `PlayerMetadata`, which `scheduler_daemon.ts`/`boot.ts` genuinely
read), so a full proto + generated client/server + auto-assigned port
would be pure overhead. Instead it rides on
`system/config.ts`'s `loadJsonConfig` — the same helper
`supervisor.ts`/`player.ts` already use for their own `/etc/*.txt` files —
called fresh on *every* tick rather than once at startup, so hand-editing
`/etc/hacknet.txt` takes effect within one tick, and survives a restart
for free (`SchedulerConfig` later adopted the same file-backed approach,
see above).

- **`hacknet_decisions.ts`** — pure, `ns`-free (mirrors `hwgw.ts`'s
  style): `decideNodeInvestment` picks the single best affordable action
  (buy a new node, or upgrade one axis of an existing one) within
  `min(money - reserveMoney, money * maxSpendFraction)` — an absolute
  floor and a relative throttle together, the same pairing
  `homeReservedRamGb`/`homeFallbackHackingLevel` uses in
  `scheduler.proto`. "Best" depends on whether the optional `gainRate`
  parameter is supplied:
  - **Without it** (no `Formulas.exe`): cheapest-affordable wins — the
    original v1 heuristic, unchanged, kept as the fallback.
  - **With it**: every candidate is scored by true ROI,
    `(productionAfter - productionBefore) / cost`, computed via
    `gainRate(level, ram, cores)` — a closure `hacknet_daemon.ts` only
    provides when `Formulas.exe` is owned, wired to `ns.formulas.
    hacknetServers.hashGainRate`/`ns.formulas.hacknetNodes.moneyGainRate`
    (the real game formulas — unlike every other capability-gated API
    touched this session, every `ns.formulas.*` function is confirmed
    0 GB RAM cost, so this needed no `detect_capabilities.ts`-style
    isolation, just a plain `ns.fileExists` check re-run every tick).
    `ramUsed` is always passed as `0` — a deliberate simplification, since
    the goal is *relative* ranking between upgrades, not predicting exact
    output (a Hacknet Server's real `ramUsed` fluctuates as
    `scheduler_daemon.ts` places HWGW workers on it), and it lets one
    3-argument closure serve both formulas (`moneyGainRate` doesn't take
    `ramUsed` at all). Cache upgrades are excluded from ROI scoring
    entirely — they don't affect production rate, only hash storage
    capacity, so they'd always score `0` and never win on merit; a known,
    explicit scope-cut is that this doesn't guard against hash-storage
    overflow, acceptable since hashes get spent every tick whenever
    anything's affordable.

  `pickHashUpgrade` returns the first name in a priority list that's both
  recognized and currently affordable, skipping anything else rather than
  erroring.
- **`hacknet_daemon.ts`** — a plain polling loop (`player.ts`'s style, not
  `scheduler_daemon.ts`'s RPC-server style), ticking every 5s (purchases
  are lumpy/infrequent — no need for the batch scheduler's 1s
  granularity). Each tick: reads `money` over `PlayerService` (no local
  `ns.getPlayer()` cost), gathers live per-node current stats
  (`getNodeStats`) and upgrade costs (`getCacheUpgradeCost` only queried
  when `hashCapacity() > 0`, since the docs mark it Server-only and don't
  specify behavior against a plain Node), builds the `gainRate` closure
  above if `Formulas.exe` exists, executes whatever `decideNodeInvestment`
  picks, and — only in a Server context — spends hashes (see "Hash
  spending" below). For the two
  target-scoped upgrades ("Reduce Minimum Security", "Increase Maximum
  Money"), `config.hashSpendTargetOverride` wins if set, otherwise it
  resolves the *same* target `scheduler_daemon.ts` is currently attacking
  (via that daemon's own exported `resolveTarget`, over a
  `GetSchedulerConfig` RPC call), so hash spending automatically
  synergizes with the HWGW loop instead of needing duplicate targeting
  config.
- **`boot.ts`** launches it alongside `scheduler_daemon.js`, last — same
  reasoning as the scheduler: real RAM cost (~17 `ns.hacknet.*`/RPC
  references), no dependency on a rooted network or ranked target, so no
  reason to compete with bootstrap-critical one-shots for a
  RAM-constrained `home`.

**Diagnosability:** unlike `scheduler_daemon.ts` (which `WARN`s on every tick
a batch doesn't fit), a `{ kind: "none" }` tick here is otherwise silent —
indistinguishable in the logs from the process being stuck. Both
`decideNodeInvestment` and `decideServerInvestment` (below) return the full
evaluation, not just the winning decision (budget, and the best/cheapest
candidate considered even if unaffordable), and both daemons run at
`LOG_LEVEL.DEBUG` and log that evaluation every tick (including whether ROI
mode or the cheapest-first fallback is active) — so a quiet daemon is always
distinguishable from a stuck one by checking its own log file, not by
comparing timestamps against other daemons' activity.

### Buying: many purchases per tick, gated by payback

Each tick, `hacknet_daemon.ts` keeps calling `decideNodeInvestment` and executing its pick until
nothing qualifies or the tick's budget runs out (at most 200 purchases). It re-reads nodes and
costs after every purchase. Budget is the same `reserveMoney` / `maxSpendFraction` limit as
before, taken once per tick. One purchase per 5s tick, the old behavior, capped a full build-out
(about 9,000 level/RAM/core/cache steps across 20 servers) at roughly 12 hours regardless of cash.

With Formulas.exe, `maxPaybackHours` (default 4, 0 = off) skips any purchase that wouldn't earn
its cost back in that time. A hash is valued at what "Sell for Money" pays for it ($1M ÷ its
live hash cost). That's a floor: the priority hash upgrades are bought because they're worth
more. An install wipes the whole Hacknet, so set it to roughly the time until the next install.
Since each upgrade costs more than the last, this limit is also what stops spending once the
fleet is built out. Capacity-driven cache upgrades (below) ignore it.

`monitoring_daemon.ts` records `gauge/hacknet_nodes`, `gauge/hash_rate` (or
`gauge/hacknet_money_rate` for plain nodes), `gauge/hashes`, and `gauge/hash_capacity`, e.g.
`run tools/monitor.js --graph gauge/hash_rate --window 3h`.

`gauge/hacking_exp` (via `PlayerService`'s `hacking_exp`) sits next to `gauge/hacking_level`.
Level grows only logarithmically with experience, so experience per minute is the rate that shows
whether studying and Improve Studying are working. The summary adds a `(+N/min)` rate to every
non-money gauge.

**Faction rep:** `faction_daemon.ts` writes every joined faction's rep and its current work target
to `/var/faction_reps.txt` each tick. The sampler records them as `gauge/rep_<faction>` (e.g.
`gauge/rep_daedalus`), skipping a file more than a minute old. Reading rep directly would put
`ns.singularity`'s RAM cost on the sampler. The summary shows only rep gauges that changed, with
a per-minute rate, so rep per second is that rate ÷ 60.

**Gang:** `gang_daemon.ts` writes `/var/gang_status.txt` each tick. The sampler records
`gauge/gang_power`, `gauge/gang_rival_power` (the strongest rival holding territory),
`gauge/gang_win_chance_pct` (the worst clash odds, which the daemon compares to
`minClashWinChance`), `gauge/gang_territory_pct`, `gauge/gang_respect` and
`gauge/gang_warfare_members`. Income is already `counter/gang`. Together they show whether
moving members onto Territory Warfare is paying off: odds climbing toward the threshold, then
territory and income rising.

**Work type by formula:** with Formulas.exe, `faction_daemon.ts` works whichever type
(hacking, field, security) earns the most rep at the work target, using
`ns.formulas.work.factionGains` with that faction's favor (`bestWorkType`). Hacking contracts
scale with hacking level alone; field work uses every stat, so with combat stats trained up it can
win. The file above also carries `workType` and each type's rep/min (`workGains`), so
`cat /var/faction_reps.txt` shows the comparison. Without Formulas.exe it still prefers hacking.

**Karma** is recorded too: `gauge/karma`, via PlayerService's `karma`. While karma still blocks a
gang, `skill_eta` shows a **Gang karma** section with the measured karma rate and the time to
−54,000. ETAs past 1,000 years print as "unreachable", and so do install comparisons where both
sides are. At BN10's start (hacking ×0.513) hacking 2500 printed as 9.8e57 years.

`run tools/skill_eta.js [hacking-target] [--window 1h]` compares both routes to a Daedalus
invite:
- **Hacking to 2500:** uses the measured experience rate, plus the configured class's rate from
  `ns.formulas.work.universityGains`, and shows milestone ETAs.
- **1500 in every combat stat:** uses the best gym per stat from `ns.formulas.work.gymGains`,
  training one stat at a time.

For each route it also says whether installing the pending augmentations now gets there sooner.
Levels are converted with `ns.formulas.skills`, using each skill's multiplier solved from
current level and experience (`skill_progress.ts`), since the BitNode's share needs SF5 to read.
ETAs assume today's rates hold.

### Hash spending

Each tick, `hacknet_daemon.ts` calls `decideHashSpend` in a loop and re-queries `hashCost` after
every purchase, since each upgrade's cost rises per level. It stops when nothing is affordable,
or after 500 purchases. The first version bought one upgrade per tick. Production outran that,
and hashes past `hashCapacity()` are lost.

- **`hashSpendPriority`** (default `["Improve Studying", "Improve Gym Training"]`): bought first
  to last, whenever affordable. The defaults suit BN9, where script hacking gives 5% of normal
  experience and 1% of normal max money. University class experience isn't nerfed there, and
  Improve Studying multiplies it, so hashes → studying is the practical route to hacking level.
  In a BitNode where script hacking pays, "Reduce Minimum Security" / "Increase Maximum Money"
  (which reuse the scheduler's target, above) belong back on this list.
- **`hashDrainUpgrade`** (default "Sell for Money") and **`hashDrainAboveFraction`** (default
  0.9): the drain only runs once hashes pass that fraction of capacity, and only when no
  priority upgrade is affordable. Selling every tick would stop hashes building up for the
  priority upgrades, whose costs keep climbing. The drain name is removed from the priority list
  even if it's listed there.
- **Capacity:** each hash upgrade costs more every level. Once all of them cost more than the
  pre-drain threshold (`hashCapacityBound`), none can ever be bought again. When that happens,
  `decideNodeInvestment` gets `needCapacity` and buys the cheapest affordable cache upgrade ahead
  of its ROI pick. Without this, ROI mode never buys cache, since cache doesn't raise
  production.
- **Current activity first:** `study_daemon.ts` writes what the player is training
  (`/var/study_activity.txt`: class, gym, or none), and `prioritizeForActivity` moves the matching
  upgrade to the front: Improve Studying in class, Improve Gym Training at the gym. It only
  reorders the configured list, and it ignores a file older than a minute.
- `/etc/hacknet.txt` values override defaults, so an existing file that already sets
  `hashSpendPriority` keeps its old list until it's edited
  (`run tools/set_config.js /etc/hacknet.txt --unset hashSpendPriority`).

## Purchased-server manager: `purchased_server_daemon.ts` (`ns.cloud`)

Grows and upgrades the fleet the scheduler draws RAM from beyond just
Hacknet Servers — this BitNode's API renamed the classic "purchased server"
mechanic to `ns.cloud` (not the older top-level `ns.purchaseServer`/
`ns.deleteServer`; confirmed by reading `NetscriptDefinitions.d.ts`
directly). File/daemon names still say "purchased server" — the well-known
community term — even though the API underneath is `ns.cloud.*`.

Same self-contained, no-proto shape as `hacknet_daemon.ts` and the same
reasoning: nothing else needs to query or patch this config remotely, so
`/etc/purchased_servers.txt` via `loadJsonConfig` (re-read every tick, live
hand-editable) beats a proto + generated client + port for no benefit.

**`SupervisorService` is the single source of truth for the fleet, not a
second `ns.cloud.getServerNames()` view of it.** Two things this fixes:
- **Discovery**: `crawl_servers.js` only runs once, at boot; `dispatch.ts`
  never re-triggers it. A brand-new hostname from `purchaseServer` would
  stay invisible to `scheduler_daemon.ts`'s worker pool indefinitely without
  a manual re-crawl. Fixed by pushing the new server's metadata in directly
  the moment `purchaseServer` succeeds — `toServerMetadata` (already
  exported by `crawl_servers.ts`) + `ns.getServer(hostname)` +
  `UpdateMetadata` — no crawl, no wait.
- **Staying current**: `ListServers`'s handler recomputes `rootStatus`/
  `hackStatus` live, but *not* `maxRam`/`ramAvailable` — those are whatever
  was last pushed. Upgrading a purchased server's RAM would leave
  supervisor's record stale otherwise, so every successful `upgradeServer`
  call is followed by a `PatchMetadata` refreshing it.

This makes the daemon's own enumeration trivially precise too — it filters
`ListServers` on `kind === ServerKind.PURCHASED` (see above) rather than
`ns.cloud.getServerNames()` (which would need its own 1.05 GB, on top of
being a second, syncable-out-of-date view of the same fleet).

- **`purchased_server_decisions.ts`** — pure, `ns`-free (mirrors
  `hacknet_decisions.ts`): `decideServerInvestment` picks the cheapest
  affordable action between buying a new server (sized to match the
  *smallest* currently-owned one, keeping the fleet balanced instead of
  buying permanently-undersized stragglers late-game, or `startingRamGb` if
  nothing's owned yet) and upgrading the weakest owned server (doubling its
  RAM, clamped to `ns.cloud.getRamLimit()`) — same budget pairing
  (`reserveMoney` floor + `maxSpendFraction` throttle) as the Hacknet
  manager, same "simplest reasonable v1, not ROI-optimal" tradeoff.
- **`purchased_server_daemon.ts`** — plain polling loop, 5s tick (lumpy,
  infrequent decisions, same reasoning as Hacknet). Reads `money` over
  `PlayerService` (no local `ns.getPlayer()` cost), enumerates owned
  purchased servers via `SupervisorService.ListServers`, executes whatever
  `decideServerInvestment` picks via `ns.cloud.purchaseServer`/
  `upgradeServer`, and patches supervisor's record as described above.
- **`boot.ts`** launches it alongside `scheduler_daemon.js`/
  `hacknet_daemon.js`, last — same reasoning: real RAM cost (~4.5 GB, six
  `ns.cloud.*` references), no dependency on a rooted network or ranked
  target.

## Stock market manager: `stock_daemon.ts` (`ns.stock`)

The third `reserveMoney`/`maxSpendFraction`-style growth daemon (after Hacknet and
purchased-server), and the first daemon in this codebase with genuine market risk — a wrong
forecast call loses money, unlike "wasted an upgrade slot." Long-only v1: buys a long position
when a stock's live forecast clears a threshold, sells to exit once it drops back down. No
shorting yet (see scope cuts below).

**No capability gate, unlike `singularityAvailable`/`gangAvailable`.** `ns.stock` has normal fixed
RAM costs (confirmed by reading every `ns.stock.*` doc comment in `NetscriptDefinitions.d.ts` —
no Source-File multiplier), so this doesn't need `program_shopper.ts`/`backdoor_daemon.ts`/
`faction_daemon.ts`'s single-file isolation invariant. And unlike Source-File 2/4 gating gangs/
singularity, there's no "stock market disabled" `bitNodeOptions` flag at all — only
`disable4SData`, which this daemon handles live at runtime (see below), not at boot time. So
`boot.ts` launches it unconditionally, same group as `hacknet_daemon.js`/
`purchased_server_daemon.js`.

**Buying API access (`ensureAccess`, runs every tick before any trading logic) is deliberately
narrower than "buy everything the Stock Market offers."** Only two purchases ever happen:
`ns.stock.purchaseTixApi()` (required for `buyStock`/`sellStock` from a script at all) and
`ns.stock.purchase4SMarketDataTixApi()` (required for `getForecast`/`getVolatility` to return real
values from a script). **A WSE account and the plain 4S Market Data purchase are deliberately never
bought** — confirmed straight from their own doc comments: `purchaseTixApi()`'s doc says *"you can
buy TIX API access without a WSE account"*, and a WSE account itself is only needed *"to perform
actions via the Stock Market UI"*; `purchase4SMarketData()`'s doc says it *"only unlocks access to
4S Market Data in the Stock Market UI"* — the scriptable variant is `purchase4SMarketDataTixApi()`
specifically. A script never touches the UI, so buying either UI-only feature would be pure wasted
money with zero functional benefit. Each purchase call is check-before-buy (only logs on the tick
it actually transitions), same discipline `manageTerritoryEngagement` already uses for territory
warfare engagement. `purchase4SMarketDataTixApi()` is additionally gated on `hasTixApiAccess()`
being true first — caught live: unlike every other purchase call touched in this codebase (which
return falsy on an unmet precondition), this one **throws** a runtime error ("You don't have TIX
API Access!") if TIX API access isn't already owned, and `purchaseTixApi()` failing that same tick
(still saving up) used to fall straight through into this call and crash the whole daemon.

**Trading defaults on** (`config.enabled`, the only switch — no separate `autoTrade` flag) once
that access exists. This groups stock-trade risk with Hacknet/purchased-server/gang-equipment
spending (all default on, ROI risk accepted as a normal cost of automation) rather than with
`installAugmentations`/committing crimes (which default off, since those are hard-to-reverse in a
way a bad trade — always sellable back, just at a loss — is not).

**The "not ready" gate is exactly `ns.stock.has4SDataTixApi()`.** Before that's true (still saving
up for it, or `disable4SData` set for this BitNode), `getForecast`/`getVolatility` must never be
trusted, so `tick()` idles-and-logs before ever calling either — the same shape `gang_daemon.ts`
already uses for its `Formulas.exe` gate. This also correctly handles a BitNode with
`disable4SData` permanently set: the daemon just idles forever there instead of assuming eventual
success.

- **`stock_decisions.ts`** — pure, `ns`-free (mirrors `hacknet_decisions.ts`). Exits and new buys
  deliberately have different shapes:
  - **`decideStocksToSell`** evaluates **every** held position each tick and returns every one
    whose forecast has dropped to `sellThreshold` or below — unbounded, not capped to one per
    tick, mirroring `gang_daemon.ts`'s `assignTasks`/`assignTraining` acting on the whole member
    roster every tick rather than one member at a time: exiting a no-longer-favorable position is
    risk reduction, not a new commitment, so there's no reason to throttle it the way new spend is
    throttled below. A symbol missing from the forecast map is always held, never sold — caught
    live by this file's own test suite that simply defaulting a missing forecast to 0.5 (neutral)
    and running it through the same `<= sellThreshold` check doesn't work, since 0.5 IS this
    daemon's own default `sellThreshold`, so that fallback would still trigger a sell right at the
    boundary; missing data is its own explicit branch instead.
  - **`decideStockToBuy`** makes one *allocation* decision per tick: it walks candidates in
    forecast order and gives each up to its own per-symbol room until the tick's budget is spent —
    the same shape as `hwgw.ts`'s `allocateAcrossHosts`, not a single winner. The first version
    bought only one symbol per tick with each position capped at a fraction of *cash*, and that
    failed live: gang income refilled cash every tick, so the top stock's cap room grew every tick
    too, it won every single tick, and every buy went to MGCP while four other qualifying stocks
    sat untouched and most of each tick's ~$2B budget went unspent. Both caps are now measured
    against **net worth** (cash + invested cost basis). The tick's budget is the tighter of the
    usual `reserveMoney`/`maxSpendFraction` spend budget and the remaining total-exposure room
    under `maxInvestedFraction`. `bestCandidate` in the returned `BuyEvaluation` still reports the
    globally-highest forecast regardless, for diagnosability. `affordable` is an injected closure
    (mirrors `purchased_server_decisions.ts`'s cost-closure pattern) returning `{shares, cost}`, so
    this module stays `ns`-free — the real closure (`stock_daemon.ts`) binary-searches
    `ns.stock.getPurchaseCost` up to `getMaxShares` minus shares already held (that ceiling is
    combined across positions), since price isn't linear in share count (spread +
    large-transaction slippage) and `getPurchaseCost` already folds in commission.
- **Thresholds**: `buyThreshold = 0.60` (comfortably past the 0.5 coin-flip line
  `getForecast` returns), `sellThreshold = 0.50` (exit the instant true edge disappears, don't
  wait for active bearishness). The gap between the two is a deliberate hysteresis band: a stock
  oscillating between 0.50 and 0.60 is never newly bought but, if already held, isn't sold either
  until it actually drops to 0.50 — damping commission-costly buy/sell thrashing right at the
  boundary. `maxVolatility = 0.05` is a binary accept/reject filter applied only to *new* buys,
  never to exits — an already-held position is never force-sold purely because its volatility
  rose, only its forecast decides that — and isn't used for position sizing (no
  inverse-volatility scaling), a deliberate v1 scope cut.
- **`maxPositionFraction` (default 0.25)** caps any single symbol at that fraction of net worth;
  **`maxInvestedFraction` (default 0.5)** caps total stock exposure at that fraction of net worth,
  keeping the rest in cash — stocks are liquid, but faction augmentation purchases and Daedalus's
  $100B money requirement only count cash on hand. Still intentionally simple — not Kelly, not
  correlation-aware — same "simplest reasonable v1, not ROI-optimal" tradeoff already accepted for
  `decideEquipmentPurchase`.
- **4S cost is BitNode-scaled**: `purchase4SMarketDataTixApi()` costs `$25B ×
  FourSigmaMarketDataApiCost`, which BN9 sets to 4 — **$100B** here, not the flat $25B constant.
  The "not ready" log line shows `hasTixApiAccess`/`has4SDataTixApi`/`money` explicitly because
  a bare "not available" couldn't distinguish saving up from being stuck.
- **`stock_daemon.ts`** — plain 5s-tick polling loop (same cadence as every sibling spending
  daemon; syncing to `ns.stock.nextUpdate()`'s ~6000ms game cycle instead was considered and
  rejected — decisions are re-derived fresh every tick regardless, so a stale price is harmless,
  and a daemon-specific rhythm would only complicate cross-daemon log correlation for no benefit).
  Config at `/etc/stock.txt` via `loadJsonConfig`, same hand-editable pattern as every other
  daemon. Reads money over `PlayerService` (no local `ns.getPlayer()` cost) — same reasoning and
  the same "no cross-daemon spend coordination exists or is needed" fact already true of every
  other spending daemon here: each computes its own budget pre-check with zero awareness of the
  others, and that's safe in practice only because the underlying engine call
  (`ns.stock.buyStock`/`sellStock`, same as `ns.hacknet.purchaseNode`/`ns.cloud.purchaseServer`/
  `ns.gang.purchaseEquipment`/`ns.singularity.purchaseAugmentation`) independently re-checks live
  money at the moment it executes and simply returns `0`/no-ops if unaffordable, never throws.
- **Scope cuts**: shorting (`buyShort`/`sellShort`) — `StockPosition`'s `position: "L"` tag exists
  specifically so this is a natural future extension, not a rewrite; limit/stop orders
  (`placeOrder`/`cancelOrder`/`getOrders`); volatility-based position sizing; Kelly/portfolio
  optimization; the UI-only WSE account/plain 4S Market Data purchases (see above — not an
  oversight, deliberately never bought).

### Pre-install wind-down: `system/install_handshake.ts`

**Spend-down stage.** After the wind-down (stock sold) and the whole-balance augmentation purchases
and donations, the cash left would just be wiped. So before installing, the faction daemon switches
the install file's `phase` to `"spendDown"`. It buys home RAM with the cash itself, and
`gang_daemon.ts` buys gang equipment with all of it, as many items per tick as it covers. Both
survive an install. It installs once cash hasn't dropped for 20s (`advanceSpendDown` /
`spendDownSettled`), meaning nothing affordable is left. The Hacknet daemon buys nothing while any
install is pending, since an install resets the Hacknet. Augmentations come first, because gang or
RAM spending before them would take cash they need. Whether gang equipment really survives an
install is from memory. Check it the first time.

**Pending counts repeats** (`pendingAugmentations`): pending is getOwnedAugmentations(true)
minus getOwnedAugmentations(false) as a multiset. A plain name filter dropped a queued NeuroFlux
Governor whenever one was already installed, so pending read 0 and auto-install never fired with
only NeuroFlux queued.

**No auto-install while `reserveMoney` > 0** in `/etc/faction.txt` (`decideInstallReady`). An
install resets cash to $1,000, which defeats the reserve. Also, with a reserve set, "nothing
affordable" means only that the reserve blocked the purchase, not that buying is done. Before
this rule, raising the reserve to $100B to save for Daedalus made the daemon treat buying as
finished. The whole-balance pre-install purchases then spent the savings, and it installed.

An augmentation install **deletes every stock position with no refund**:
`initStockMarket()` replaces every `Stock` object, and shares live on those objects. It also
**resets cash to $1,000** (`PlayerObjectGeneralMethods.ts`: `this.money = 1000 + ...`). Both
were confirmed in Bitburner's source. TIX API and 4S access survive an install; only a new
BitNode clears them (`prestigeSourceFile`). Before this existed, `faction_daemon.ts` decided to
install purely from *cash* (nothing affordable, augmentations pending), with no idea stocks
existed. With `autoInstall` on, that could delete tens of billions held in stock.

The fix is a handshake through one flag file, `/var/install_pending.txt` (`{since, heartbeat}`):
1. When an install is ready, `faction_daemon.ts` first spends the **whole** cash balance
   (`decidePreInstall`). It ignores `reserveMoney`/`maxSpendFraction` for this, since there's
   no later to save for; the old 50% throttle could leave half the cash on the table at install.
2. If nothing is affordable but stock is still held, it writes the flag and waits, refreshing
   `heartbeat` every tick.
3. While the flag is active, `stock_daemon.ts` sells every position regardless of forecast and
   buys nothing. Only `stock_daemon.ts` ever trades.
4. The freed cash comes back through step 1 and is spent on augmentations (most expensive
   first, as usual). Once nothing is affordable and no stock is held, `faction_daemon.ts`
   deletes the flag and installs.

If the install stops being ready mid-wind-down (e.g. `autoInstall` turned off), the flag is
deleted and trading resumes. A heartbeat older than 10 minutes stops counting
(`isInstallPendingActive`), so a `faction_daemon.ts` that dies mid-wind-down can't leave the
portfolio in cash forever. The known gap is the other way around: if `stock_daemon.ts` isn't
running (or `enabled: false`), nobody sells, and `faction_daemon.ts` waits rather than
installing over the holdings. It logs that it's waiting on `stock_daemon.js` every tick.

### `tools/stock_server_report.ts`: which known servers are actually stock-linked

A one-shot diagnostic, same shape as `check_cloud.ts`/`augmentation_report.ts`. Confirmed via
Bitburner's own source (`StockMarket/PlayerInfluencing.ts`, see the next section) that `hack()`/
`grow()` can only ever move a stock's forecast on a server whose `organization` matches a real
stock — most NPC servers (`n00dles`, `foodnstuff`, etc.) have no stock at all. Rather than
hardcode the hostname/company/symbol mapping from Bitburner's source, this derives it entirely
from live data (same "derive from live game data" taste as `pickWorkType`/`hacknet_daemon.ts`'s
`HashUpgradeName`): `SupervisorService.ListServers()`'s already-crawled `organization` field
(populated by `crawl_servers.ts`, confirmed in `server_metadata.proto`) cross-referenced against
`ns.stock.getOrganization(sym)` for every live symbol. No `ns.getServer()` call needed, no new
plumbing — `organization` was already flowing end-to-end, just never consumed by anything until now.

## Stock-targeting mode: `Approach.STOCK_TARGETING` (`scheduler_daemon.ts`) + `stock_target_daemon.ts`

**Confirmed game mechanic this whole feature is built on** (Bitburner's own source,
`StockMarket/PlayerInfluencing.ts`, `influenceStockThroughServerHack`/`...Grow`): only `hack()`/
`grow()` can nudge a stock's forecast — `weaken()` never does (no such function exists for it).
Each call has a *chance* (not a guarantee) of a nudge, equal to `moneyMoved / server.moneyMax` —
scales with what fraction of the server's absolute max money that one call moved, not thread
count directly. It only ever applies on a server whose `organization` matches a real stock
(`orgName !== "" && StockMarket[orgName] instanceof Stock`), and only when the call passes
`{stock: true}` — which our worker scripts never did before this feature, so the mechanic was
completely dormant even on any stock-linked server we might already have been attacking.

**Step 1: `stock: true` is now always passed, unconditionally, no config flag.**
`hack_worker.ts`/`grow_worker.ts` read a third `ns.args` entry and add `stock: true` to the
options object; `scheduler_daemon.ts`'s `fireOn` (in `fireBatchIfRoom`) and `prep()` both pass it
as the extra `ns.exec` positional arg on every launch, including weaken (harmless —
`weaken_worker.ts` itself needs no change at all, an extra arg it never reads is simply ignored).
This is unconditional and permanent, not gated behind any new `SchedulerConfig` field: the game's
own influence functions immediately no-op on a server with no matching stock, so there is zero
cost to always passing it, and it's the prerequisite for anything below to matter at all — even
plain `Approach.HACK` benefits for free if its current income-ranked target happens to be
stock-linked.

**Step 2: `Approach.STOCK_TARGETING`, a new value in `scheduler.proto`'s already-extensible enum**
(the enum's own doc comment already frames `GROW_STATS`/`CRIME` as placeholders "defined now so
the schema doesn't need another breaking change later" — this is exactly that kind of addition).
`fireBatchIfRoom` runs identically under `HACK` and `STOCK_TARGETING` — they only disagree about
which target `resolveTarget()` picks; neither the batch math nor the hack/grow thread ratio is
biased toward manipulation. **Deliberately not doing that**: our own HWGW batches already move a
real fraction of `moneyMax` every cycle by design (that's the whole point of the hack/grow
phases), so once `stock: true` is flowing, no thread-ratio bias is needed for a real effect —
trading real hacking income for a slower, second-order, probabilistic forecast nudge would be a
bad trade under this codebase's "simplest reasonable v1" ethos.

**Step 3: `stock_target_daemon.ts` — a new, small, always-on daemon, deliberately kept separate
from `scheduler_daemon.ts` itself.** `scheduler_daemon.ts` is already the single most
RAM-expensive script in this codebase (~8.6 GB, launched last specifically to avoid starving
bootstrap-critical scripts) — `ns.stock.*` has normal fixed RAM costs (no isolation
*requirement* the way `ns.singularity` has), but growing an already-maxed-out script for a niche
mode is still worth avoiding, so the stock-aware ranking lives in its own tiny process instead,
the same RAM-isolation reasoning `target_selector.ts` already exists for its own money/security
ranking. Every 5s (not change-triggered like `target_selector.ts`, which only recomputes on a
hacking-level change or a rooter completion — "which stock we hold long" changes on the timescale
of `stock_daemon.ts`'s own 5s tick, so a change-triggered design would go stale almost
immediately):
- Builds an `organization -> cost basis` map (`gatherLongPositionCostBasisByOrganization`) from
  `ns.stock.getSymbols()`/`getPosition`/`getOrganization` — long-only, matching `stock_daemon.ts`'s
  own v1 scope; short positions are never considered.
- Queries `SupervisorService.ListServers({ eligibleOnly: true })` — rooted, has money, and within
  hacking level, the same filter `target_selector.ts` uses. Without it, a held-long stock whose
  server is above our hacking level (e.g. `megacorp` at hacking level 858) would pin the whole
  fleet onto a target every batch tick skips (`hackAnalyzeThreads` returns -1) — caught before
  first use, when the first live long position turned out to be MGCP.
- `computeStockTargetWeights` (pure, unit-tested) ranks every such server whose `organization` is
  in that map by cost basis descending — defend the biggest position first. Simple and not
  ROI-optimal (ignores current forecast, volatility, proximity to `sellThreshold`) — same
  "simplest reasonable v1" tradeoff `target_selector.ts`'s own `maxMoney/minSecurityLevel`
  placeholder heuristic already accepts.
- Writes to `/var/stock_target_selector/weights.txt`, reusing `target_selector.ts`'s own exported
  `WeightsFile`/`WeightedServer` types verbatim — zero new parsing code, `scheduler_daemon.ts`
  reads it with the exact same `readWeightsFile` helper it already uses for the normal ranking.
  The written `hackingLevel` field is always `0` and meaningless here (that field only means
  something to `target_selector.ts`'s own staleness check) — nothing reading this file ever looks
  at it, only `weights[0]?.hostname`.

No capability gate needed (same reasoning as `stock_daemon.ts`) — `boot.ts` launches it
unconditionally, same low-priority group as `hacknet_daemon.js`/`purchased_server_daemon.js`/
`stock_daemon.js`.

**`resolveTarget` gets a second tier, with automatic fallback:**
`config.targetOverride` keeps its absolute, unconditional priority over everything (unchanged).
Under `Approach.STOCK_TARGETING`, `resolveTarget` next tries `stock_target_daemon.ts`'s weights
file; if nothing qualifies there (no stock-linked long position exists right now), it falls
through to the exact same money/security ranking `Approach.HACK` uses directly — nothing to
defend shouldn't mean the whole scheduler idles over an empty portfolio. **The honest tradeoff
this doesn't remove**: `scheduler_daemon.ts` only ever runs one target at a time (confirmed), so
while `STOCK_TARGETING` is active *and* a qualifying position exists, the scheduler's entire
attack capacity goes to defending that position instead of the highest-money/security target —
real, deliberate income-vs-stock-support tradeoff for as long as both conditions hold. The
fallback only softens the "nothing to defend" case, not this one.

**Switching modes**: `tools/set_scheduler_approach.ts` (usage:
`run tools/set_scheduler_approach.js STOCK_TARGETING` or `... HACK`) calls `PatchSchedulerConfig`,
which writes through to `/etc/scheduler.txt` — picked up within `scheduler_daemon.js`'s next
1000ms tick, and survives restarts. (`/etc/scheduler.txt` stores `approach` as a bare enum
number, so the tool is the readable way to change it.)

**Scope cuts**: no automatic cross-daemon triggering — `stock_daemon.ts` can't (yet) tell the
scheduler "please support symbol X"; switching `Approach.STOCK_TARGETING` on/off is a
manual/scripted human decision via the tool above, not automatic. A future iteration could have
`stock_daemon.ts` itself flip it when a position gets large or risky, but that's real
cross-daemon coordination logic not justified until the manual version proves worthwhile.

## Sleeves: `sleeve_daemon.ts` (BitNode 10 / Source-File 10)

Sleeves are extra workers running beside the player. A sleeve's crimes lower the **player's** karma.
The experience it earns is shared with the player, scaled by its shock (lower is better) and sync
(higher is better). It can also do faction work, one worker per faction. Each sleeve gets one goal
per tick (`decideSleeveGoals`), in priority order:

1. **Gang karma:** in `Approach.GANG`, while karma still blocks a gang, the crime that lowers
   karma fastest for *that sleeve's* stats (`bestCrimeBy`, using `formulas.work.crimeSuccessChance`
   on the sleeve).
   A sleeve's crime karma is scaled by its sync (karma × sync / 100, as far as the game's code goes),
   so a low-sync sleeve adds little: BN10's one sleeve at sync 25 barely moved the rate. So in this
   phase a sleeve first **synchronizes if that reaches −54,000 sooner** (`syncPaysOff`). It compares
   the time at today's rate against syncing to 100 and finishing at the full rate, with the player's
   own crime counted on both sides. The sync rate is measured, not assumed (`updateSyncRate`,
   readings ≥1 minute apart while syncing). While it's unknown the sleeve syncs briefly to measure
   it. The rate is kept in `/var/sleeve_state.txt` and shown in `/var/sleeves.txt` as `syncPerMin`.
2. **Recovery:** shock recovery down to `maxShock`, then synchronize up to `minSync`
   (`/etc/sleeve.txt`, defaults 0 and 100).
3. **Faction rep:** work at a joined faction still short of a rep target. The faction daemon
   publishes these as `repTargets` in `/var/faction_reps.txt`: the favor-plan target, else the
   largest wanted augmentation's requirement. One sleeve per faction. The player's faction comes
   first while it's short of its target, so two workers finish its favor target sooner.
   `tools/sleeve_probe.js` confirmed the game allows this and keeps the player working. After
   that, the closest target first, with the work type chosen by formula for that sleeve.
4. **Otherwise,** the crime earning the most money.

A task already matching the goal is never restarted (`taskMatchesGoal`). If the game refuses a
faction (e.g. the player just took it), the sleeve does money crime until the next tick. Status is
written to `/var/sleeves.txt`. Boot launches it right after the gang daemon, only when sleeves exist
(`sleevesAvailable`). Buying sleeves, memory and sleeve augmentations is left for later.

## Gang mode: `Approach.GANG` — founding a gang (Source-File 2)

`run tools/set_scheduler_approach.js GANG` sets up a gang in a BitNode that doesn't start with one.
Outside BitNode 2, creating a gang needs karma at **−54,000** (`GANG_KARMA_REQUIREMENT`), and
karma only drops by committing crimes.

- **Faction daemon:** while not in a gang and karma still blocks one (`karmaBlocksGang`), the work
  slot commits the crime that lowers karma fastest: karma per success × success chance ÷ time
  (`pickKarmaCrime`, from `getCrimeStats`/`getCrimeChance`). This comes ahead of invites and
  faction work. It isn't counted toward the crime-for-kills circuit breaker.
  `/var/faction_reps.txt` shows `karmaCrime` with the success chance and current karma.
- **Gym first while the crime fails too often** (`gangTrainingStat`). If the karma crime's success
  chance (`getCrimeChance`) is below `gangCrimeMinChance` (default 0.8), the work slot trains the
  weakest combat stat at the gym instead, if affordable, since each failure wastes the crime's full
  time. The first BN10 run measured ~0.5 karma/s at ~50% Homicide success, about half the
  full-success rate, and the gym raises combat stats far faster than crimes do. Crimes also build the
  combat stats for the Slum Snakes invite (combat 30, karma −9, $1M), which the auto-join accepts.
- **Gang daemon:** once karma allows, it calls `createGang` with the first joined faction in
  `gangFactionPriority` (combat gangs only; the task scoring assumes combat tasks). From then on
  it manages the gang as before.
- **Share daemon:** idle, since crime earns no rep. Scheduler batches run as in HACK. Once the gang
  exists, player work goes back to normal even if the mode stays GANG.
- **Speed:** Homicide is about −3 karma per ~3s success, so roughly 15 hours solo. Sleeve crimes
  lower the player's karma too, which is the sleeve daemon's first job.

## Augments mode: `Approach.AUGMENTS` + the shared savings target

**NeuroFlux Governor is decided in one place** (`catalogsFor`). It used to be bought through every
path: normal purchases, 90%-of-cash donations and the pre-install spend-down, and its rep gaps
picked the work target (grinding at Sector-12). Each purchase also raised QLink's price 1.9×. Now
it may be bought only when **both** hold:
1. **An install is about to happen.** It's only in the `preInstall` catalog, so it's always the
   last thing bought.
2. **Its faction offers nothing else still wanted,** so it never competes with, say, QLink at
   Illuminati.

The `regular` catalog (buying, donating, work targets) never has it. The remaining full-catalog
uses (`favorPlan`, `priorityFocus`, `redPillFocus`) exclude it themselves.

**Mode-aware daemons read the approach from `/etc/scheduler.txt`** (`system/phase.ts`),
not over RPC. These are the faction, study and share daemons. The file is the source of truth,
since `PatchSchedulerConfig` writes through to it, and reading it costs 0 GB. The RPC version
treated a failed call as "not that mode". Right after an install, boot starts the scheduler last,
so the call timed out and the faction daemon silently dropped AUGMENTS. It then bought NeuroFlux
instead of saving for QLink, and each purchase raised QLink's price 1.9×.

`run tools/set_scheduler_approach.js AUGMENTS` steers the whole system's spending toward good
augmentations. The scheduler's batches and the player's work (favor plan, wanted invites, faction
work) are the same as HACK.

- **What "good" means** (`priorityFocus`): The Red Pill first. After that, the most **expensive**
  wanted augmentation (not owned, not NeuroFlux, prereqs owned) that raises a multiplier in
  `augmentationFocus` (default hacking and hacking_exp) and is reachable this install cycle,
  meaning its rep is met or its faction takes donations.
- **Held, not just preferred.** While that augmentation exists it's the only thing bought or
  donated for, using all cash instead of `maxSpendFraction`. Each purchase raises every remaining
  price by 1.9× within the batch: QLink at $25T would be about $90T after SPTN-97 and one
  NeuroFlux. Unreachable augmentations hold nothing, since the next install resets the inflation
  anyway. Outside AUGMENTS, only The Red Pill is held this way.
- **The install loop** (`maxFocusWaitMinutes`, default 5; `focusPriceLimit`). Only augmentations
  costing at most cash plus that many minutes of income are saved for, the dearest of them first.
  Income is every counter that rose over the last 10 minutes, from monitoring, not counting stock
  sales. With nothing pending, prices are at base and an install couldn't lower them, so the cap is
  longer: at least an hour (`NOTHING_PENDING_MIN_MINUTES`). If nothing is within that either, the
  cheapest reachable one is saved for, so the loop always moves. A 5-minute cap there once stalled
  BN10's loop; no cap at all then saved 6.3h for one $126T QLink while a favor-banking install
  waited. That install's enabler purchase is no longer blocked by savings. Once none is left, whatever is affordable gets bought and, with `autoInstall`, the
  install resets the 1.9× inflation. The gang survives installs and keeps earning, so short
  cycles of buy, install, buy beat saving hours for one inflated augmentation. An earlier version
  dropped the most expensive augmentation outright when it was too far away. That fell back to
  slow half-of-cash buying in cheap-first order. Once the wind-down has started nothing is held,
  so growing cash can't flip the hold back on. The Red Pill is always waited for. With no
  monitoring data there's no limit. `tools/status.js` shows pending count, time since the last
  install and the switches, and warns when AUGMENTS mode can't install.
- **When the focus runs out** (`secondaryAugmentationStats`, default the four combat stats and
  their exp; `focusStatsFor`). Once no `augmentationFocus` augmentation is left reachable at any
  price, AUGMENTS widens to every useful stat, which includes these. Daedalus takes 1500 in every
  combat stat in place of 2500 hacking, and The Covenant and Illuminati have combat routes too.
  BN10's loop had bought every hacking augmentation Slum Snakes sells and then stalled: $18T in
  cash, 25M rep, nothing bought. It's a new key so that it reaches existing `/etc/faction.txt`
  files, where the old keys' written values win over changed defaults.
- **The shared savings target** (`system/savings.ts`, `/var/savings.txt`). The
  faction daemon writes the augmentation's price plus any donation still needed, every tick, and
  removes it otherwise. Hacknet, stock and purchased-server daemons spend only above
  `max(reserveMoney, target)`. **Gang equipment is exempt:** it raises the gang income that fills
  the savings, so holding it back made saving slower. In BN10, a $5.26T target for Embedded
  Netburner Module had blocked every gang purchase. The stock daemon also sells everything once cash plus its
  positions' cost basis covers the target. A target more than a minute old is ignored, so a dead
  writer can't freeze every spender. Auto-install also waits while saving, because an install
  would wipe the savings.
- **Invite cash counts too.** A wanted invite (`pursueAugmentationFactions`) that's blocked only
  on cash (Illuminati $150B, The Covenant $75B) sets the savings target to that amount
  (`unmetMoneyRequirement`), and the faction daemon's own non-focus buying and donations stay
  above it. Before this, NeuroFlux donations kept cash below the requirement, the invite never
  came, and the work slot fell back to grinding NeuroFlux rep at Sector-12.
  `/var/faction_reps.txt` shows `inviteAction: "<faction>: waiting for $…B cash"`.
- This replaces the per-file `reserveMoney` edits used for BN9's Daedalus $100B wait.

## Grow-stats mode: `Approach.GROW_STATS` + `study_daemon.ts`

`run tools/set_scheduler_approach.js GROW_STATS` switches the player from faction work to studying.
`... HACK` switches back. Like STOCK_TARGETING, the approach is the one switch several daemons
read over the `GetSchedulerConfig` RPC:

- **`scheduler_daemon.ts`:** keeps running the same HWGW batch loop, so the fleet keeps earning.
- **`study_daemon.ts`** (`ns.singularity`, launched only when `singularityAvailable`): trains
  toward a Daedalus invite, which takes hacking 2500 **or** 1500 in every combat stat. Each tick
  it estimates both routes from 0 GB formulas: each skill's multiplier is solved from level and
  experience, and rates come from `universityGains` for `course` at `university`
  (`/etc/study.txt`, default "Algorithms" at "ZB Institute of Technology") and from `gymGains` at
  the best gym for each stat. If the combat total (stats train one at a time) is shorter, it
  trains the first unfinished stat at its best gym (`chooseTraining`); otherwise it studies.
  Once Daedalus is joined or w0r1d_d43m0n is visible, the combat route no longer matters and it
  only studies. It travels first when needed and never restarts the activity already running
  (`decideStudyStep`). Without Formulas.exe it always studies.

  Why the choice matters: after the BN9 install, hacking 2500 was ~2.5 days of class, while
  combat multipliers of x12–x40 (from years of gang-faction combat augmentations) put all four
  stats at 1500 in ~6 minutes at Powerhouse Gym.
- **`faction_daemon.ts`:** gives up the work slot (no faction work, no eligibility work, no
  city-faction travel), so the two daemons don't restart over each other every tick. It also
  changes what it buys and when it installs, because the level multiplier sits inside an
  exponent (`skill_progress.ts`). At x5.3, +10% level multiplier cuts the experience needed for
  hacking 2500 by about 4×, while +10% experience rate saves only 10%:
  - **Buys** (and donates for) only augmentations raising a multiplier in
    `augmentationFocus` (default `["hacking", "hacking_exp"]`; NeuroFlux qualifies).
  - **Installs** only when `compareInstall` says installing reaches `growStatsHackingGoal`
    (0 = w0r1d_d43m0n's requirement, else Daedalus's 2500) sooner. It compares experience still
    needed now with experience needed from zero at the boosted multiplier, divided by the
    experience boost; the rate cancels out. The ratio must be at most `growStatsInstallMaxRatio`
    (default 0.8), leaving margin for the Hacknet and its study upgrades, which an install also
    resets.
- **`share_daemon.ts`:** drops to 0 threads, since share only boosts faction and company rep.

Why it exists: in BN9, scripts earn 5% of normal hacking experience, but university classes
aren't nerfed, and the "Improve Studying" hash upgrade multiplies them. That upgrade does nothing
unless the player is actually in a class, which nothing did before this mode.

## Backdoor + Faction managers: the first steps toward actually finishing a BitNode

Everything above grows money and hacking level forever but never moves
toward *completing* a BitNode — that requires factions, augmentations,
and eventually hacking `w0r1d_d43m0n`. `backdoor_daemon.ts` and
`faction_daemon.ts` are the first two pieces of that (join factions, work
for reputation, optionally buy augmentations and install them); nothing
here yet drives toward the endgame server itself.

**No proto changes were needed for either.** `Metadata.backdoorInstalled`
(field 13) and `Metadata.pathFromHome` (field 4, `"home -> a -> b"`) were
already in `server_metadata.proto`, already populated live by
`crawl_servers.ts` from `ns.getServer()` — just never acted on before.
Faction/augmentation state doesn't get a service either: like
`hacknet_daemon.ts`'s node stats, it's cheap to re-derive fresh from
`ns.singularity.*` every tick, and nothing else in the codebase needs to
consume it, so a new `FactionService` would have been machinery with no
second caller.

- **`backdoor_daemon.ts`** — mirrors `rooter.ts`'s shape exactly (a pure
  `selectBackdoorTargets` filter + a thin loop, no separate decisions
  file, same as `rooter.ts`/`rooter_test.ts`). Filters
  `SupervisorService.ListServers` to `rootStatus === ROOTED && hackStatus
  === HACKABLE && kind === NPC && !backdoorInstalled`. `hackStatus` is
  required, not optional: `rootStatus === ROOTED` only means enough ports
  were open to `nuke` — rooting has no hacking-level check at all — while
  `installBackdoor()` needs the same hacking-skill check as an actual
  hack, which is the other, independent axis (see "Two independent axes,
  not one lifecycle chain" above; hit this exact bug live — `computek`
  rooted fine but was above hacking level, and `installBackdoor` threw).
  Walks each target's `pathFromHome` hop by hop via
  `ns.singularity.connect()` (it can only connect to a direct neighbor —
  confirmed in `NetscriptDefinitions.d.ts`), calls `installBackdoor()`,
  connects back to `home`, then `PatchMetadata`es `backdoorInstalled: true`
  back — the exact call shape `rooter.ts` already uses for `rootStatus`.
- **`faction_decisions.ts`** — pure, `ns`-free (mirrors
  `hacknet_decisions.ts`). Only ever makes *one* decision per tick
  (join/work-target/buy), the same "re-derive everything fresh next tick"
  shape as the Hacknet manager, so there's no purchase queue to track
  across calls. `decideAugmentationPurchase` picks the cheapest
  augmentation that's affordable, has its reputation requirement met, and
  has every prereq already owned (including augmentations bought-but-not-
  yet-installed this session — `ns.singularity.getOwnedAugmentations(true)`).
  NeuroFlux Governor is the one exemption from "already owned" exclusion —
  it's uncapped and repeatable, unlike every other augmentation. The
  price inflation the game applies after every purchase (to *all*
  remaining unpurchased augmentations, not just the one bought) needs no
  special modeling here: since only one augmentation is bought per tick
  and prices are re-queried live from `ns.singularity` every tick, the
  inflation is already reflected by the time the next decision runs.
- **`faction_daemon.ts`** — the impure shell. Config at `/etc/faction.txt`
  via `loadJsonConfig` (same live-hand-editable pattern as Hacknet/
  purchased-server). `autoPurchaseAugmentations`/`autoInstall` both
  **default to false** — buying spends real money and
  `ns.singularity.installAugmentations(bootScript)` wipes every running
  script and reboots straight into `bootScript` (`boot.ts` re-detects
  capabilities and relaunches everything, including this daemon, from
  scratch) — so the daemon runs safely in "join + grind reputation only"
  mode until both are explicitly enabled. **No persisted state of its
  own** — `ns.getPlayer().factions` gives the live, current membership
  list directly, so there's nothing to keep in sync. This wasn't the
  original design: it used to persist its own `/var/faction_state.txt`
  copy, on the (mistaken) reasoning that membership "can't be re-derived
  live" since `checkFactionInvitations()` stops listing a faction once
  you're in it — true of that one function, but
  `ns.getPlayer().factions` gives it directly regardless. That file lived
  on home and survived an `installAugmentations` reset untouched even
  though the reset clears `Player.factions` entirely (confirmed against
  Bitburner's own `PlayerObjectGeneralMethods.ts`: `this.factions = []`,
  restoring only `keep`-flagged factions and the gang's own founding
  faction) — so the daemon kept believing it was still joined to
  factions it had actually lost, forever blocking re-invitation. Reading
  `ns.getPlayer().factions` fresh every tick has no such staleness
  window, and also correctly picks up any faction joined outside this
  daemon entirely (e.g. manually, to found a gang) instead of never
  learning about it — a real gap the file-based version had even before
  any install ever happened.
- Both are the second and third files (after `hacking/program_shopper.ts`)
  allowed to reference `ns.singularity.*`, each isolated in its own script
  for the same RAM-cost reason. `boot.ts` launches both alongside
  `program_shopper.js`, gated behind `singularityAvailable`.
- **`tools/augmentation_report.ts`** — a fourth `ns.singularity`-touching
  file, but a one-shot diagnostic (`run tools/augmentation_report.js`),
  not a daemon `boot.ts` launches. Dumps everything relevant to "should
  we install augmentations yet": current money/hacking level/Hacknet
  node count (what an install resets), joined factions' reputation, the
  full not-yet-owned augmentation catalog (price already reflecting the
  live `1.9^queuedCount` batch-purchase multiplier — confirmed via
  Bitburner's own source, `AugmentationHelpers.ts`/`Constants.ts` —
  rep/prereq/affordability per entry), the pending (bought-not-installed)
  list, and gang status. Reuses `faction_daemon.ts`'s own `gatherCatalog`/
  `gatherReps`/`getPendingAugmentations` (all exported for this) and feeds
  the same data through the real `decideAugmentationPurchase`/
  `decideInstallReady` so its "what would happen right now" lines are the
  live decision, never a separately-derived guess. Same reasoning for the
  gang section: reuses `gang_daemon.ts`'s exported config/state readers
  and `gang_decisions.ts`'s `decideStandDown`.
- **`tools/bitnode_status_report.ts`** — a fifth `ns.singularity`-touching
  file, same one-shot shape as `check_cloud.ts`/`augmentation_report.ts`.
  Answers "how far from actually finishing the BitNode," not just "are we
  growing": Daedalus's real invite requirements (confirmed in Bitburner's
  own `FactionInfo.tsx` — 30 installed augmentations via
  `BitNodeMultipliers.DaedalusAugsRequirement`'s default, not confirmed
  whether BN9 overrides it; $100B; hacking level 2500 or every combat
  stat at 1500), whether The Red Pill is owned vs. actually *installed*
  (only installed reveals `w0r1d_d43m0n` — confirmed in `ServerHelpers.ts`,
  it's excluded from the network entirely otherwise), and once visible,
  its root status and required hacking skill. Explicitly notes that
  nothing here calls `ns.singularity.destroyW0r1dD43m0n()` yet — that
  final step has no automation at all, by design, until there's a
  concrete reason to build it (i.e. this report showing everything else
  is actually ready).

### Donations: buying an augmentation's missing reputation with money

`ns.singularity.donateToFaction` converts money into reputation, but only at a faction where your
favor has reached `ns.getFavorToDonate()` (150 by default, scaled by the BitNode). Favor only
grows at install time, from the rep earned that run. The gang's own faction can never take
donations. `tools/augmentation_report.js` shows each faction's favor, the favor it gains at the
next install, and whether it can take donations. It also shows, per reputation-blocked
augmentation, the donation that would unlock it.

When nothing is purchasable outright, `faction_daemon.ts` runs `decideDonation`. It looks for
an augmentation at a donatable faction where donating the rep gap **plus** the augmentation's
price fits the spend budget, since a donation that leaves the augmentation unaffordable would
just burn money. It picks the most expensive one, the same price-inflation reasoning as
`decideAugmentationPurchase`. NeuroFlux Governor is offered by several factions at the same
price, so ties go to the smallest donation, i.e. the faction already closest to the requirement.
The daemon donates exactly that amount; the normal purchase path buys the augmentation next
tick. The amount comes from `ns.formulas.reputation.donationForRep` (0 GB, needs Formulas.exe)
plus 0.1%, so float rounding can't leave the rep a hair short. Nothing is hardcoded from the
game's formula (`amount / $1M × faction_rep mult × BitNode FactionWorkRepGain`, per
`Faction/formulas/donation.ts`).

- **Config:** `autoDonate` (default **true**), which only acts when `autoPurchaseAugmentations`
  is also on, since a donation only ever happens to make an augmentation buyable.
  `donationSpendFraction` (default 0.9) is the donation's own budget fraction, separate from
  `maxSpendFraction`: a donation-unlocked augmentation usually costs far more in donation than
  in price, so the normal fraction would rarely let one through.
- **Pre-install:** the same whole-balance rule as `decidePreInstall` applies. With nothing left to
  buy outright, a donation that fits the *entire* remaining cash is made before installing,
  because the install is about to wipe that cash anyway.
- **The Red Pill comes first** (`redPillFocus`). Once it's buyable, or its faction (Daedalus)
  takes donations, it's the only augmentation bought or donated for. Everything else waits, so
  the cash builds up for its donation. Both deciders rank by price, so otherwise a $0 Red Pill
  lost to every repeatable ~$170B NeuroFlux donation elsewhere. Getting Daedalus to 150 favor
  means about 462k rep before one install (favor = ln(1 + rep/25,000) / ln(1.02)); then the rep
  can be bought.
- **Favor plan** (`favorPlan`, `decideWorkTarget`'s `plan`). Donations need
  `ns.getFavorToDonate()` favor, and favor only arrives at an install, from the rep earned before
  it. When a joined faction's wanted augmentation (not owned, not NeuroFlux) needs more rep than
  reaching that favor does, the cheaper route is to earn just the favor's rep, install, and donate
  for the rest. BN9's Daedalus took 462k rep instead of 2.5M. The daemon works such factions,
  closest first, only up to their target (`repForFavor`, from
  `ns.formulas.reputation.calculateFavorToRep`), then moves on. `/var/faction_reps.txt` shows
  the plan and `favorPlanReady`, and the log says so once. **Installing is still manual:** turn on
  `autoInstall` with an augmentation pending.
- **Only useful augmentations count** (`usefulCatalog`, `usefulAugmentationStats`). By default
  those are the ones raising hacking level/experience/chance/speed/money/grow or faction rep, plus
  The Red Pill. Buying, donating, the pre-install spend-down, the work target, the sleeves' rep
  targets and the favor plan all start from this list, in every mode. Before it, every augmentation
  counted: BN10 worked Netburners for rep and bought its five Hacknet augmentations (5× price, each
  raising every later price 1.9×), none of which helped. `augmentationFocus` still narrows further
  in GROW_STATS/AUGMENTS.
- **Never the gang's own faction** (`workableFactions`) for the favor plan, rep targets or work
  target. Its rep comes from gang respect, and it can never take donations. BN10 had put Slum Snakes
  in the favor plan and made it the player's work target. Buying its augmentations is unaffected.
- **Wanted invites** (`pursueAugmentationFactions`, default Illuminati, The Covenant, Daedalus). An
  install drops every faction, and these sell the big augmentations. While one of them isn't joined
  and still sells something wanted (`wantedInviteFactions`), the daemon works toward its invite
  before any faction work, using the criminal factions' requirement engine: a combat gap becomes
  gym time, while money and hacking gaps are waited out. It never picks crime. Gym workouts now
  travel to the gym's city first. The default `gymLocation` is Powerhouse Gym, the
  highest-experience one.
- **What it can't do:** unique augmentations at factions below the favor threshold (e.g.
  BitRunners at favor ~102, gaining ~2 per install) still need rep grinding, which
  `share_daemon.ts` speeds up (see "Share manager" below).

### Active faction eligibility: city, company, and criminal factions

Everything above only ever reacts to `checkFactionInvitations()` — it never does anything to
become eligible for a faction we're not yet invited to. Added at the user's request ("identify
factions we can and try to install all non-NeuroFlux-Governor augmentations... doing the steps to
travel to places or meeting other criteria to join factions as needed"), scoped to three chosen
categories: **city factions**, **company factions**, **criminal/gang factions**. Hacking factions
stay fully covered by `backdoor_daemon.ts` above; Netburners/TianDiHui need no new work either
(passively satisfied by `hacknet_daemon.ts`'s growth, or a free win of the same generic `city`
machinery below). Illuminati/Daedalus/The Covenant/Bladeburners/Church of the Machine
God/Shadows of Anarchy stay out of scope — huge stat/money/aug thresholds already tracked by
`tools/bitnode_status_report.ts`, or entirely separate subsystems (an infiltration minigame,
Source-File gates) with no clean automation path.

**Key discovery this is all built on**: `ns.singularity.getFactionInviteRequirements(faction)`
returns the exact, structured, live `PlayerRequirement[]` tree the game itself evaluates for that
invite (confirmed against `NetscriptDefinitions.d.ts`'s own worked example for "The Syndicate").
So none of this hardcodes a threshold (money amount, rep floor, stat level) — it reads the live
tree and reacts, the same "derive from live game data, don't duplicate a table" taste already
used by `pickWorkType` above and `hacknet_daemon.ts`'s `HashUpgradeName` derivation. It also
confirmed company factions need only `employedBy` + `companyReputation` — no job-title/promotion
chase needed at all. The one surprising API detail: each combat stat arrives as its **own**
top-level `skills` entry (`{type:"skills", skills:{strength:200}}`), not one entry listing all
four — this matters for the "largest gap wins" logic below.

Extends `faction_daemon.ts`/`faction_decisions.ts` in place rather than adding new daemon files:
`workForFaction`/`workForCompany`/`gymWorkout`/`commitCrime` all fight for the single work slot
(confirmed via `getCurrentWork()`'s discriminated `Task` union and each function's own doc, which
says calling it cancels whatever's in progress), so arbitration needs one process; and RAM
isolation is about not leaking `ns.singularity`'s Source-File-4-scaled cost into
`supervisor.ts`/`scheduler_daemon.ts`, not about minimizing one file's size — `faction_daemon.ts`
already pays that tax, so referencing `travelToCity`/`applyToCompany`/`workForCompany`/
`getCompanyRep`/`quitJob`/`gymWorkout`/`commitCrime`/`getCrimeChance`/`getCrimeStats`/
`getFactionInviteRequirements` there creates no *new* leak. (Unmeasured tradeoff: this does grow
`faction_daemon.js`'s own RAM cost meaningfully, amplified at low Source-File 4 levels — if that
later proves too large to coexist with the other daemons on a RAM-constrained `home`, the fallback
is splitting only the crime-related piece, the rarest-firing and priciest, into its own gated file
with a small ownership flag; not built preemptively.)

- **`faction_decisions.ts`**'s requirement→action engine (all pure, `ns`-free save one type-only
  `PlayerRequirement` import erased at compile time — no different from this file's existing
  type-level use of `NS` for `FactionNameType`/`FactionWorkTypeType`): `evaluateRequirement`
  recursively evaluates one `PlayerRequirement` (money/skills/karma/numPeopleKilled/employedBy/
  companyReputation/city/not/someCondition/everyCondition modeled; anything else — `jobTitle`,
  `location`, `file`, `numAugmentations`, hacknet totals, `bitNodeN`, `sourceFile`,
  `bladeburnerRank`, `numInfiltrations` — returns `true`, an optimistic default, since this only
  ever picks the *next action*, never gates an actual join). `findBlockingRequirement` walks the
  implicitly-ANDed top-level array (plus nested `everyCondition`/`someCondition`) left to right for
  the first unsatisfied, actionable leaf — **except** once the scan reaches a `skills` entry with
  no earlier non-skill blocker in the way, at which point it compares every unsatisfied combat-stat
  entry found anywhere in the list and returns whichever has the **largest** remaining gap, not the
  first-found or smallest. This is the mirror image of `decideWorkTarget`'s "smallest gap wins" —
  there only one thing needs to finish; here all four combat stats must clear an AND, so the
  slowest stat is the actual bottleneck (same "obvious first guess is wrong" style as
  `decideAugmentationPurchase`'s rearrangement-inequality doc above). Caught live in this file's
  own test suite: comparing skill gaps *before* checking whether an earlier, unrelated blocker like
  `not(employedBy)` was still open let combat training hijack priority from a one-call `quitJob`
  fix — fixed by only ever entering the "largest gap" comparison once `unsatisfied[0]` is itself
  already a `skills` entry. `requirementToAction` maps one blocking requirement to a concrete
  `EligibilityAction` (`travel`/`applyToCompany`/`workForCompany`/`quitJob`/`gymWorkout`/
  `commitCrime`) — `commitCrime`'s crime name is deliberately left `""`, since picking one needs
  live `getCrimeStats`/`getCrimeChance` data this pure function has no access to;
  `decideCrimeForKills` (data-driven over every live `CrimeType`, never a hardcoded `"Homicide"`
  string) and `faction_daemon.ts`'s `pickCrimeForKills` resolve it. `decideEligibilityStandDown`
  mirrors `gang_decisions.ts`'s `decideStandDown` exactly.
- **City factions** (`CITY_FACTION_NAMES`): `pursueCityFactions` only ever produces a `travel`
  action (invites gate on `city` + `money`, and money isn't actionable) and stops the whole
  category dead once **any** city faction is joined (`hasAnyCityFaction`) — city factions are
  mutually exclusive within a BitNode run (each lists some of the others as `enemies`, permanently
  banned on join). Rather than model that graph (confirmed asymmetric via Bitburner's
  `FactionInfo.tsx` — a second source of truth that could drift), this just stops: correct
  regardless of the exact graph, since `checkFactionInvitations()` will never surface an enemy's
  invite again once we're in one of its enemies, so continuing to chase one after that point is
  pure waste. `cityFactionPriority` (default: Sector-12 first) controls which one gets pursued.
  `TianDiHui` gets no dedicated pursuit logic — it shares this same generic `city`-requirement
  machinery, so it's a free win if the player ever lands in Chongqing/New Tokyo/Ishima for any
  other reason, not something actively chased.
- **Company factions** (`COMPANY_FACTION_NAMES`): `pursueCompanyFactions` has no short-circuit —
  companies stack normally. `companyReps` is populated live per-candidate (only for whichever
  employer is actually being evaluated, not eagerly for all ten), since Fulcrum Secret
  Technologies' employer (`Fulcrum Technologies`) differs from its faction name — the one mismatch,
  resolved via `COMPANY_FACTION_EMPLOYER`. `companyJobField` is a single config string, not
  ROI-optimized by salary/rep-gain-rate — same "simplest reasonable v1" tradeoff
  `decideEquipmentPurchase` already accepts for gang equipment.
- **Criminal/gang factions** (`CRIMINAL_FACTION_NAMES`): the karma requirement (-9 to -90 across
  the six) is a non-issue in practice for anyone already running a gang — `ns.gang.createGang()`
  requires karma far more negative than any of these six need, so it's already satisfied with zero
  new work; `requirementToAction` never even produces an action for a bare unsatisfied `karma`
  leaf, only for `numPeopleKilled`. `pursueCriminalFactions` walks `criminalFactionPriority` once:
  safe actions (`gymWorkout`/`quitJob`/`travel`) from **any** candidate faction are returned
  immediately, while a `commitCrime` need is deferred (only the first one found) so every safe
  option across the whole category is tried first — risk-ascending, matching the work-slot policy
  below. The deferred crime only actually fires if `enableCrimeForKills` is on (default **false** —
  the one genuinely irreversible, game-telegraphed-as-serious action in this whole feature) and
  `/var/faction_state.txt`'s `crimeAttempts` circuit breaker (mirrors `gang_state.txt`'s
  `casualties` exactly) hasn't tripped `maxCrimeAttempts`; tripping logs once, with exactly how to
  resume, same as `decideStandDown`'s gang-side counterpart. Silhouette's `jobTitle` (executive)
  requirement is left unmodeled/non-actionable — it simply never produces an action and joins
  passively if the player manually reaches a C-level title, exactly as before this feature existed;
  kept in the default `criminalFactionPriority` list anyway (a harmless no-op) rather than
  special-cased out, since removing it would require a reader to already know why.
- **Work-slot priority policy** (`tick()`): highest to lowest, one action executed per tick — (1)
  `decideWorkTarget` (existing, unchanged) always wins if it returns a target; (2) city travel runs
  *unconditionally* alongside whichever of (1) or below wins, since `travelToCity` never touches
  the work slot; (3) company pursuit, only tried when (1) found nothing; (4) criminal pursuit's
  safe branch, only when (1) and (3) found nothing; (5) criminal pursuit's risky `commitCrime`
  branch, only when (1)/(3)/(4) found nothing and `enableCrimeForKills` is on. This doesn't make
  the feature dead code: with `autoPurchaseAugmentations` at its own default `false`, reputation
  keeps accumulating past every augmentation's `repReq` with nothing spent on it, so
  `decideWorkTarget` legitimately returns `undefined` once every joined faction's augmentations are
  rep-satisfied — a common steady state in exactly this "join + grind, don't buy yet" mode, not a
  rare edge case — so the work slot genuinely sits idle in the default posture, and this policy
  uses that idle time productively without ever preempting active progress toward a purchase. The
  3→4→5 order is risk-ascending: company work is reversible (`quitJob`), gym training is fully
  safe, crime is the one action with a real downside.
- **Config** (`/etc/faction.txt`): `pursueCityFactions`/`pursueCompanyFactions`/
  `pursueCriminalFactions`/`enableCrimeForKills` all default to **false** — with every one left
  off, `faction_daemon.ts` behaves exactly as it did before this feature (strictly additive, opt-in
  by design, same posture as `autoPurchaseAugmentations`/`autoInstall`). `enableJobQuitForFactions`
  was considered but dropped from the actual config — `quitJob` only ever fires from a
  `not(employedBy)` blocker under `pursueCriminalFactions`, already its own top-level opt-in gate,
  so a second flag guarding the same action would be redundant.
- Both `faction_decisions.ts`'s new pure functions and this whole engine leave the counts above
  unchanged — no new `ns.singularity`-touching *file* was added (see the RAM tradeoff note above
  for the one scenario that could still add a sixth).

## Gang manager: `gang_daemon.ts`

Manages an *already-created* gang — task assignment, equipment purchases,
ascension, recruiting. **Doesn't automate creating the gang itself**
(`ns.gang.createGang`), which needs sufficiently negative karma outside
BitNode 2 (i.e. automating crime) — a separate, out-of-scope piece of
work; `tick()` just idles (logging once) until `ns.gang.inGang()` is
true, same as the player creating one manually today.

`ns.gang` is gated behind **Source-File 2**, not 4 — a capability fully
independent of `singularityAvailable`, so it gets its own
`PlayerMetadata.gangAvailable` field and its own
`computeGangAvailable`/`boot.ts` gate, mirroring
`computeSingularityAvailable` exactly (see above). **Unlike
`ns.singularity.*`, `ns.gang.*` functions have normal fixed RAM costs** —
no 16×/4×/1× Source-File multiplier, confirmed by reading every
function's doc comment — so `gang_daemon.ts` doesn't need the same
single-file isolation invariant `program_shopper.ts`/`backdoor_daemon.ts`/
`faction_daemon.ts` have. It's still its own daemon purely for the same
config/log modularity reason Hacknet and purchased-server are split.

Task scoring is entirely `ns.formulas.gang`-driven (0 GB, gated by
`Formulas.exe` — already owned, same as the Hacknet ROI mode):
`GangTaskStats` has no discrete "task type" field (no money/respect/
wanted enum — confirmed by reading the full interface), so picking a
task by name pattern-matching (e.g. hardcoding `"Vigilante Justice"`)
isn't type-safe or robust. Instead `moneyGain(gang, member, task)`/
`wantedLevelGain(gang, member, task)` give real per-tick numbers for any
member+task pairing, and `gang_decisions.ts`'s `decideMemberTask` just
picks the best-scoring one. No non-formula fallback exists here (unlike
Hacknet) — without `Formulas.exe`, `gang_daemon.ts` just idles.

- **`gang_decisions.ts`** — pure, `ns`-free (mirrors `hacknet_decisions.ts`).
  `decideMemberTask` maximizes `moneyGain` for most members, never picks
  "Unassigned" or "Territory Warfare" (a fresh member earns $0 at every
  task, and that tie once left it idle on "Unassigned"), and trains
  (Train Combat / Train Hacking) while no task pays anything yet;
  `GangGenInfo.wantedPenalty` is a *multiplier* (1.0 = no penalty at all,
  dropping toward 0 as wanted level outgrows respect — confirmed live: a
  healthy gang sat between 0.979 and 1.000, never anywhere near 0), so
  the trigger is `wantedPenalty` dropping *below* `config.minWantedPenalty`
  (a floor, e.g. `0.9`), not exceeding a max — got this backwards on the
  first pass, which silently reserved members for wanted-control duty
  nearly all the time even with no actual wanted problem. Once genuinely
  triggered, a `config.wantedReductionFraction` slice of the roster (by
  stable index) switches to whichever task minimizes `wantedLevelGain`
  instead — same "ROI-*informed*, not ROI-*optimal*" tradeoff already
  accepted for Hacknet/purchased-server, not a joint optimization across
  the whole roster. `decideEquipmentPurchase` is cheapest-first
  affordable, same shape as `decideNodeInvestment`'s non-ROI fallback —
  **deliberate scope cut**: a true ROI version would need to simulate
  each equipment's stat-multiplier effect on `moneyGain` first, but the
  exact stacking rule for `EquipmentStats` onto `GangMemberInfo`'s
  `*_mult` fields isn't nailed down anywhere in
  `NetscriptDefinitions.d.ts`, so this doesn't guess at it.
  `decideAscension` (per-member threshold check) and
  `selectBestAscensionCandidate` (picks at most the single best-scoring
  eligible member) together enforce **one ascension per tick, never
  more** — ascending costs the gang's entire respect pool
  (`GangMemberAscension.respect`: "amount of respect lost from
  ascending"), and the first version ascended every eligible member in
  the same tick, crashing live respect from 357M to 38.5K in one shot
  (a one-time backlog of years of unspent stats, but the pacing bug
  would repeat it any time several members cross the threshold at once).
  Same "one decision per tick, re-derive fresh next tick" pacing already
  used for equipment/Hacknet/purchased-server/faction purchases.
  `decideAscension`'s average is over a member's *trained* stats only
  (factors > ~1.0, i.e. actually earned some experience) — averaging in
  every stat unconditionally meant a combat-focused member's permanently
  untrained `hack` factor (always ~1.0, since they never work hacking
  tasks) dragged the average below threshold even when every stat that
  member actually uses cleared it comfortably. Caught live: the in-game
  UI showed every member as ascension-ready while the buggy version kept
  rejecting all of them.
  Recruiting has no decision function at all (trivial: recruit whenever
  `canRecruitMember()` allows it), same reasoning `rooter.ts`'s `root()`
  isn't wrapped in one either.
  **`decideTrainingTask`** pulls a member into `"Train Combat"`/`"Train
  Hacking"` (confirmed against Bitburner's own `tasks.ts`: these produce
  zero money/respect/wanted, so 100% of their output is stat exp, unlike
  every money/wanted-control task which dilutes exp across whatever its
  formulas need) once their `averageMultiplier` is within
  `config.trainingReadyMargin` of `minAscensionGainMultiplier` (e.g.
  `0.95 * 1.1 = 1.045`) — reactive, not a standing reservation, so only
  members already close to ascending forgo income, not the whole roster
  indefinitely. `assignTraining` carves these off in `gang_daemon.ts`
  before `assignTasks` ever sees them, same shape as
  `assignTerritoryWarfare`'s carve-then-return-remainder.
- **`gang_daemon.ts`** — plain 5s-tick polling loop (same cadence as
  Hacknet/purchased-server). Config at `/etc/gang.txt` via
  `loadJsonConfig`. Reads money over `PlayerService` (no local
  `ns.getPlayer()` cost) — gang income needs no separate collection step,
  it flows straight into the same money `player.ts`/`PlayerService`
  already track. `boot.ts` launches it gated behind `gangAvailable`,
  independent of the `singularityAvailable`-gated block above.

### Territory: `GangPosture` (`gang.proto`), no longer a scope cut

Originally `ns.gang.setTerritoryWarfare` was never called at all (a scope cut, since
`NetscriptDefinitions.d.ts` doesn't document clash-loss consequences). Reversed after pulling
Bitburner's actual source (`src/Gang/formulas/formulas.ts`, `src/Gang/Gang.ts`) at the user's
request: 0% territory suppresses money/respect gains by **orders of magnitude**
(`territoryMult` floors at `0.005` vs. a `>1` *bonus* at high territory for tasks with a
meaningful `territory.money`/`.respect` weight, e.g. `1.5` for Human Trafficking) — not cosmetic,
and worth pursuing carefully rather than leaving off forever.

**Key mechanic that makes a *safe* growth phase possible**: gang `power` accrues from members
assigned to the `"Territory Warfare"` task **unconditionally, every cycle, regardless of whether
`setTerritoryWarfare(true)` has ever been called** (`Gang.ts`'s `calculatePower()`/
`processTerritoryAndPowerGains`) — building power and risking real clashes are two independent
switches in the game's own code. So training power is zero-risk; only *engaging* clashes is
risky (`clash()` rolls a real, permanent ~0.35%/0.175% (lost/won) chance of a member dying, plus
territory changing hands based on `getChanceToWinClash`'s `myPower/(myPower+theirPower)`).

- **`gang.proto`** (new, enum-only, no `service` — mirrors
  `system/rpc/status.proto`'s exact shape, confirmed as a supported pattern in
  `protos/build.mjs`'s `serviceNodes.length === 0` branch): `enum GangPosture { CONSOLIDATE = 0;
  GROWING = 1; }`. `GangConfig.posture` in `/etc/gang.txt` stores the **string** form
  (`"CONSOLIDATE"`/`"GROWING"`), not the raw numeric enum — every other config file in this
  codebase is meant to be hand-edited as readable JSON, and a bare `"posture": 1` would break
  that. `parsePosture` converts it to the real `GangPosture` enum at the point of use, the same
  boundary-casting pattern `hacknet_daemon.ts` already uses for `HashUpgradeName`/`FactionNameType`.
  Defaults to `"CONSOLIDATE"` — opt into `"GROWING"` explicitly, same "ask before hard-to-reverse"
  spirit as `autoInstall`/`autoPurchaseAugmentations` defaulting off in `faction_daemon.ts`.
- **Few ascensions until the gang is full** (`ascensionThreshold`). While the gang has fewer than
  `fullGangSize` (12) members, a member ascends only for a gain of at least
  `earlyAscensionGainMultiplier` (2×) instead of `minAscensionGainMultiplier` (1.1×). Training and
  the pre-ascension equipment skip use the same bar. Ascending costs respect, and recruits come
  from respect. BN10's new gang sat at 10 of 12 with ~177K respect.
- **Nothing bought just to be lost at ascension.** Ascension throws regular equipment (weapons,
  armor, vehicles, rootkits) away and keeps gang augmentations. So each tick ascends *before*
  buying (it used to buy first, and a member could lose same-tick purchases). Gang augmentations
  are bought before equipment. Members who already qualify for ascension get no regular equipment
  until they've ascended (`skipEquipmentBeforeAscension`).
- **Equipment in bulk** (`maxEquipmentCost`, default $4B). Every tick the gang daemon buys every
  affordable item up to that per-item price, cheapest first, as many as cash allows. Each purchase
  still respects `reserveMoney`, `maxSpendFraction` and the savings target, re-reading cash after
  every buy, but not the savings target (see the AUGMENTS section). One item per 5s tick had taken
  ~30 minutes to equip a full gang. Regular equipment is
  lost on ascension (gang augmentations aren't), which is acceptable at this price.
- **`decideTerritoryWarfareAssignment`** (`gang_decisions.ts`) carves `config.territoryWarfareMembers`
  members off the front of the roster onto `"Territory Warfare"` whenever posture is `GROWING`
  and the circuit breaker (below) hasn't tripped — zero otherwise, and also zero once no rival
  holds territory (100% is ours, nobody left to clash with, so everyone earns and warfare is
  switched off). Rivals exclude our own gang: `getAllGangInformation` includes it, and once we
  held territory our 50% odds against ourselves became the "worst". The remaining members still go
  through the existing money/wanted-control logic (`assignTasks`), re-indexed within that
  remaining subset so the wanted-control reservation fraction stays meaningful.
- **`decideTerritoryReadiness`** gates *engaging* clashes: true only if our power favors us
  (`myPower/(myPower+rivalPower) >= config.minClashWinChance`, default `0.65` — comfortably past
  break-even, not just `>0.5`) against **every** rival currently holding territory (from
  `ns.gang.getAllGangInformation()`), not just the average — one bad matchup is enough to lose
  territory back even while winning everywhere else. `manageTerritoryEngagement` only calls
  `setTerritoryWarfare` when the desired state actually differs from
  `gang.territoryWarfareEngaged`, same discipline as the `ns.singularity.workForFaction` fix
  (never restart an already-correct state every tick for no reason).
- **Casualty circuit breaker**: `/var/gang_state.txt` (mirrors `faction_daemon.ts`'s
  `/var/faction_state.txt` exactly — separate from policy config, daemon-owned) tracks
  `lastKnownMemberCount`/`casualties`. `detectCasualties` compares tick-over-tick member count
  (accounting for a same-tick recruit so it doesn't mask a death), and once cumulative casualties
  reach `config.maxCasualties` (default `1` — a single permanent death is enough),
  `decideStandDown` trips and the daemon **overrides `posture` at runtime without touching
  `/etc/gang.txt`** — zero Territory Warfare assignment, `setTerritoryWarfare(false)` — logging
  exactly how to resume (edit `/var/gang_state.txt`'s `casualties` back down, or delete the file).
  Nothing auto-clears it; same "a permanent loss requires an explicit human decision to retry"
  principle as `autoInstall`/`autoPurchaseAugmentations`.

## Reloader: `reloader.ts`

New builds reach the game as changed files through bitburner-filesync, but a running script keeps
the code it started with. `reloader.js` starts with the first daemons in `boot.ts`. Every 10s it
fingerprints each managed daemon on home (`MANAGED_DAEMONS`): the daemon's file plus everything it
imports, transitively (`fingerprint`, `importedScripts`). When a fingerprint changes and then holds
for one more check (`decideReloads`, so a restart never lands mid-sync), it kills that daemon and
runs it again with the same threads and arguments. Workers, one-shot tools, bootstrap and the
reloader itself are never restarted this way. When its own code changes, the reloader exits, and
`system/log_rotator.js` starts the new version within its 60 s sweep. It's a watchdog both ways:
the reloader revives the log rotator, and the log rotator revives the reloader. Reloading itself
with `ns.spawn` once left no reloader running, and so no command queue.

It also **revives crashed daemons** (`decideRevivals`). A managed daemon it saw running that
disappears is started again with the same threads and args, at most 3 times an hour. The warning
includes the dead script's last 5 log lines, from `ns.getRecentScripts()`, so the crash is
visible. After 3 it logs one error and stops. Runs with `--once` finish on purpose and are never
tracked. Nothing else stops a managed daemon: an install or `test_restart` kills the reloader
too. So a daemon you kill by hand comes back; kill the reloader first.

The reloader also revives daemons it never saw. `boot.js` writes the daemons it started to
`/var/expected_daemons.txt`, and the reloader loads that list when it starts. After a game
restart the game brings back only some scripts, and a fresh reloader used to have nothing to
compare against. BN10's second run sat 49 minutes without the scheduler, faction, sleeve,
hacknet, study and stock daemons.

## Health check: `tools/status.ts`

`run tools/status.js [--window 10m]` prints problems first, then a one-screen summary: mode, cash
and income rates, savings target, what the player is doing, rep targets, gang, sleeves, and any
pending install. It reads only what daemons already publish (status files, monitoring series, the
scheduler's log) plus home's process list, so it's cheap and can't disturb anything.

The checks (`tools/status_checks.ts`, pure and tested) each cover a stall that once went unnoticed
for hours:
- core daemons not running; optional ones missing;
- status files gone stale;
- batches with no second weaken (`/W0`);
- a scheduler stuck on "not hackable", or showing no batches or prep;
- no hacking income;
- a savings target more than a day away;
- the gang stand-down;
- gang odds good but territory warfare not engaged;
- no gang equipment bought despite cash;
- working a faction with no useful rep target left;
- idle sleeves;
- an install pending for over 30 minutes.

Karma progress is reported with an ETA. New checks belong there whenever a new silent failure
turns up.

## Monitoring: `monitoring_daemon.ts` + `tools/monitor.ts` (`/var/monitoring/`)

Where money comes from and goes, over time, without digging through daemon logs. It's a minimal
time-series store, not an event log. The existing logs still answer "what happened" (which
augmentation was bought, and exactly when); this answers "what's the trend."

- **Storage (`system/monitoring/timeseries.ts`)**: one small JSON file per series at
  `/var/monitoring/<kind>/<name>.txt`, e.g. `counter/gang`, `gauge/net_worth`. The step is a fixed
  60s and timestamps are implied by position (`{start, step, values}`), so each point costs one
  number. There's a hard cap of 1440 points (24h); appending past it drops the oldest and advances
  `start`. The cap matters because files on `home` are stored in the save file. A slot the
  sampler missed (e.g. during a restart) is filled with `null`, so a gap stays a gap rather than
  invented data. The pure core (`appendPoint`/`windowPoints`/`counterRates`) has no `ns`
  dependency and is unit-tested.
- **Sampler (`monitoring_daemon.ts`)**: a 60s loop and the only writer of every file under
  `/var/monitoring/`. Counters are every nonzero category of `ns.getMoneySources().sinceStart`, the
  game's own cumulative totals. So nothing that earns or spends money needs instrumenting, and
  nothing is hardcoded about which categories exist. It uses `sinceStart` rather than
  `sinceInstall` so installing augmentations doesn't reset them. Gauges are `cash` and
  `hacking_level` (via `PlayerService`), `stock_value` (long positions at bid price, only with TIX
  API access), and `net_worth` (cash + stock value). About 10 GB, launched in `boot.ts`'s
  low-priority group. **Not** in `wipe_data.ts`'s `WIPE_PREFIXES`, so history survives
  `test_restart.js`.
- **Spending is negative.** `getMoneySources()` records spending categories (augmentations,
  hacknet_expenses, servers, ...) as amounts that accumulate *downward*, and `stock` can go down on
  realized losses. So `counterRates` reports signed rates. An earlier version treated any
  negative change as a counter reset and nulled it, which silently blanked every spend series.
  Caught by rendering sample output before shipping. With `sinceStart`, the only true reset is a
  new BitNode, which shows up as a single spike.
- **CLI (`tools/monitor.ts`)**:
  - `run tools/monitor.js [--window 1h]` prints the summary table. Counters are grouped into
    INCOME/SPEND by the sign of their change over the window, sorted by size, with unchanged ones
    dropped; each row shows Δ total, average per minute, and min/max per-minute rate. Gauges show
    start → end. This is the compact "state of the economy" view to paste for a check-in.
  - `--graph <id>[,<id>...]` draws up to 4 series as an **SVG** chart, printed with
    `ns.tprintRaw` (0 GB, takes a React element). By default there's one **stacked panel** per
    series, each with its own y-axis, since one shared scale let a single −$20B hacknet spend
    spike flatten gang into a line. `--overlay` puts every series on one panel with a shared
    y-axis, for directly comparable series like `income,spend`, and rejects mixing money with
    a plain-number gauge. Counters are graphed as per-minute rate; spend counters are shown as
    a positive magnitude labeled "spent", so higher always means more money moving. Gauges are
    graphed as value. The presets `income` and `spend` sum every counter's rate by direction.
  - **`--stack`** draws a stacked area chart instead of lines: each series is a filled band on
    top of the ones below it, so the top edge is the total and each band is one source's
    share. On its own, `--graph income --stack` (or `spend`) expands the preset into its
    categories (`directionalRates`). That's the "where does income come from" view, e.g. gang
    87% / hacknet 9% / stock 3%. `stackBands` puts the largest total at the bottom, where its
    flat baseline makes the shape easiest to read. It counts a missing or null point as 0,
    since an area can't have holes, and clamps negatives to 0. An income category can dip
    below zero for a minute on a realized stock loss, which would otherwise fold its band back
    through the one below. The legend sits to the right in the same top-to-bottom order as the
    bands, with each category's share of the window total. Stacks can use all 8 palette
    colors, while line charts stay at 4 series. Beyond 8 categories, the smallest merge into
    "other" (`mergeSmallest`). `--stack` and `--overlay` are mutually exclusive, and both
    require series in the same units.
  - **Axes:** y ticks use the standard "nice numbers" rounding (`niceTicks`: steps of
    1/2/5×10ⁿ, so labels read $1B/$2B rather than $1.37B). X ticks land on round clock times
    (`timeTicks`: every 5m/10m/1h/…, at most 7), not equal fractions of the window, which had
    produced labels like 17:53/17:59. Points are placed by *timestamp* (`plotPoints`), so a
    series that started recording late sits at its real time, and nulls split the line so gaps
    stay gaps.
  - **Axis controls:** `--ymin`/`--ymax` (`500M`, `5B`, `1.5T`, … via `parseAmount`) fix either
    end of the y-axis exactly, with the other end still auto-rounded; values outside are
    clamped to the edge. `--window` sets the x span, and `--ago` shifts it back in time (e.g.
    `--window 2h --ago 1h`).
  - **Why SVG, and why `globalThis.React`:** an earlier text renderer drew joined box-drawing
    lines (`╭╯╮╰│`), but Bitburner's terminal adds spacing between rows, so they rendered as
    disconnected fragments. That was caught live, since it looked fine in an ordinary terminal.
    React comes from `globalThis.React`, **not** `lib/react.ts`: Bitburner's RAM calculator
    (`RamCalculations.ts`) charges **25 GB** to any script referencing the identifier `window`
    or `document`, and `lib/react.ts` does `window.React`. `globalThis` is the same object and
    isn't charged. Layout was checked by rendering `buildChart` through a stand-in
    `createElement` that serializes to SVG markup, then rasterizing it outside the game.
  - `--list` shows every series with its point count and span. The summary stays text, since
    it's the view to paste for a check-in.
  - Windows/`--ago` accept `30m`/`2h`/`45s` or bare minutes. Series ids tab-complete.
  - The pure pieces (`parseWindow`, `parseAmount`, `formatMoney`, `formatSummary`,
    `aggregateByDirection`, `directionalRates`, `niceTicks`, `yRange`, `timeTicks`, `plotPoints`,
    `stackBands`, `mergeSmallest`, `bandPolygon`) are unit-tested
    in `tools/monitor_test.ts`; the `React.createElement` wrapper (`buildChart`) isn't.
- **Scope cuts**:
  - No coarser long-retention tier yet (e.g. 10-minute averages for a week).
  - No custom per-daemon series yet (e.g. batches fired per minute). Adding one later means that
    daemon writes its own file under its own `<kind>/`, which keeps the single-writer-per-file
    rule.

## IPvGO: `go/go_daemon.ts`

Plays IPvGO without stopping. Each win raises the opponent faction's node power, which grows a
lasting bonus:
- Illuminati: faster hack, grow and weaken.
- Daedalus: reputation.
- The Black Hand: hacking money.
- Netburners: hacknet production.
- Tetrads: combat stats.
- Slum Snakes: crime success.

- **Opponent choice** (`pickOpponentByValue`): it plays whichever opponent adds the most
  weighted bonus per second:
  - the gain is weight × (bonus after one more average game − bonus now) ÷ average game length
  - the bonus curve is the game's own (`bonusFor`), which flattens as node power grows, so play
    spreads across opponents once one is built up
  - Illuminati on 5×5 earns ×8 difficulty
  - the weights come from the phase (`system/phase.ts` `goWeights`): crime success and combat in
    GANG, reputation in AUGMENTS and FACTION_GRIND, combat in GROW_STATS, hacking otherwise
  - `/etc/go.txt` `opponentWeights` overrides them
  - installs zero node power, which it detects from the game's own count of games played
    (`powerNow`)
- **Move choice** (`chooseMove`): a one-ply evaluation of every legal point, scored by:
  - captures and rescuing our chains in atari first
  - then putting enemy chains in atari, and pressure on chains with few liberties
  - then the change in area, estimated by influence (each empty point belongs to the nearest
    stone).

  It never fills its own territory, never puts its own chain in atari, and never drops a weak
  stone into the opponent's territory. When nothing scores above zero, it passes.
- **RAM** stays about 10 GB, because the board rules are our own (`go_engine.ts`): only
  `getBoardState` and `makeMove` cost RAM (4 GB each). The game's analysis calls cost 8–16 GB
  each.
- **Strategies per opponent** (`go_strategy.ts`): the first strategy for each opponent is our
  model of its AI (`go_opponent_model.ts`).
  - Each candidate move is answered by the AI's predicted replies (sampled over its random
    choices) and scored by `evaluateBoard`.
  - Against Illuminati, each line is first played out four more moves each (`rollout4`, about
    130 ms a move).
  - The model is written from how the game's AI behaves:
    - its priority list per faction
    - its random thresholds
    - its "smart" filter, which avoids moves that can be captured at once
    - the standard 3×3 shapes from Michi, an MIT-licensed Go engine

    None of the game's code is copied: the game's source is used for testing only (`gosim/`).
  - It predicts the real AI's move 53–81% of the time, depending on the opponent.

  Against the real AI, the model beat every plain-search strategy (node power per game):

  | Opponent | Model | Best plain search |
  |---|---|---|
  | Illuminati | about 121 (rollout4) | 70 |
  | Daedalus | 34 | 28 |
  | Tetrads | 27–31 | 22 |
  | The Black Hand | 24 | 22 |
  | Slum Snakes, Netburners | tied | tied |

  The daemon still checks live: UCB1 over the first strategy and one comparison.
- **Game history** (`/var/go_history.txt`): every finished game is logged as one JSON line:
  - opponent, strategy and board size
  - the starting board, and whether the game was resumed after a restart or redealt
  - every move (`X12`, `Opass`, ...)
  - both scores, the result, node power and length

  The game keeps the newest 300. The bridge appends each new one to
  `game/archive/go_history.jsonl` on this machine, which keeps them all. Use it to evaluate
  strategies on real games later.
- **Opponent priors:** until our own games say otherwise, each 5×5 opponent's power per game is
  taken from those benchmarks (`OPPONENTS.powerPerGame5x5`), weighted as five games.
- **Search on small boards** (`chooseMoveMinimax`, used up to `searchMaxBoardSize`, 5 by
  default): a full-width alpha-beta search `searchDepth` plies deep (3 by default). The position
  score (`evaluateBoard`) is area by influence plus group safety:
  - a group with two eyes counts in our favour, one in atari or with two liberties counts against
    us
  - each separate chain costs 3, because loose stones die on a 5×5 board.

  Benchmarked against the one-ply engine playing a handicapped white (60 games): average score
  rose from 6.3 to 9.8, wipe-outs fell from 22 to 12, and wins rose from 2 to 10, at about 8 ms
  per move. An opening book was tried and dropped: random dead nodes make almost every starting
  position new (33 of 33 seen once).
- **Restarts:** a game in progress when the daemon starts is finished, not reset, since resetting
  a game with moves forfeits it.
- **Tests:** self-play against a random opponent wins 46 of 50 games on 7×7 and 50 of 50 on
  9×9, at under 50 ms per move.
- **Installs reset it:** an install zeroes node power, wins and streaks; only faction rep survives
  (`Go.prestigeAugmentation`). The bonus is rebuilt after every install.

## Share manager: `share_daemon.ts` + `share_worker.ts`

`ns.share()` raises the reputation gain of all faction work while it runs, by
`1 + ln(threads) / 25` (100 threads ≈ +18%, 1,000 ≈ +28%, 10,000 ≈ +37%). It's the lever for
augmentations at factions that can't take donations yet (see "Donations" above).

- **`share_worker.ts`** is just `while (true) await ns.share();` (about 4 GB per thread).
- **`share_daemon.ts`** ticks every 30s. It keeps `fleetFraction` of the worker fleet's total RAM
  running share threads. The fleet is the scheduler's host pool: rooted, not `home`, not Hacknet
  servers, which run for hashes. It launches onto the hosts with the most free RAM first, and a
  partial placement is fine, unlike an HWGW batch. When over target (after lowering the fraction
  or setting `enabled: false`), it kills the smallest processes first. The scheduler already
  works from live free RAM, so it simply batches with whatever is left.
- **Config** `/etc/share.txt`: `enabled` (default true), `fleetFraction` (default **0.1**). The bonus
  is logarithmic (1 + ln(threads)/25; each doubling adds about 2.8%). On BN10's ~4.9 PB fleet, 50%
  gave ×1.533 rep and 10% gives ×1.468, while 10% frees about 1.9 PB for batches, whose hacking exp
  scales with threads. The old 0.5 suited BN9, where HWGW batches earned almost nothing.
- **GROW_STATS:** the target drops to 0 while the scheduler approach is GROW_STATS (see
  "Grow-stats mode"), since the player isn't doing rep work then.
- **Diagnosability:** every tick logs fleet size, target, running threads, the predicted bonus,
  and the game's actual `ns.getSharePower()`.

## Grinding only to the favor target; the free work slot

Rep is ground only as far as cash can't buy it. Past that, the player's time goes to training.
- **A planned faction stops at its favor target** (`favorPlan`, `decideWorkTarget`, `repTargets`).
  That's the rep this run that lifts it to donation favor (150) at the next install. Daedalus is
  included, so The Red Pill takes the favor route too. The rest is bought with a donation after
  the install.
- **Donatable factions are never ground**, since cash buys their rep. Nor is NeuroFlux Governor:
  its rep is part of its cost through donations. The earlier NeuroFlux work fallback is gone.
- **Sleeves follow the same `repTargets`.** The first one joins the player's faction while it's short of its target.
- **The free work slot** (`workSlotFree`, `/var/work_slot.txt`). With no work target, no invite
  work, no karma crime and no slot-claiming eligibility action, `study_daemon.ts` takes the slot
  as it does in GROW_STATS. It uses the gym for Daedalus's combat route when that's sooner, and
  studies otherwise. Hacknet hashes follow what it trains. When cash can't cover the training
  runway, it commits the best money crime (`bestMoneyCrime`, Mug without Formulas.exe) instead of
  leaving the player idle. BN10's second run sat idle at $16.7K right after an install.
  Before either, a free slot **writes a missing program** (`pickProgramToCreate`). That's the
  first port opener, then Formulas.exe, whose hacking level is met and that cash can't buy yet;
  the program shopper buys whatever cash covers. Installs wipe programs, and nothing used to
  write them, so right after an install few servers could be rooted until cash came back.
- **Share follows faction work** (`shareWanted`). It runs while the player or any sleeve works a
  faction, since share multiplies all faction-work rep, a sleeve's included. Otherwise the RAM
  goes back to batches. Without the status files it falls back to the old rule: off in GROW_STATS
  and GANG.

## FACTION_GRIND mode and the training planner

`Approach.FACTION_GRIND` (6) is the long rep phase, for when AUGMENTS has nothing left it can
reach:
- **Batches** run as in HACK.
- **Rep is ground only up to favor targets,** as in every mode.
- **Installs whenever that finishes the grind sooner** (`grindAllowsInstall`, `grindInstallPays`),
  and otherwise once every favor target is met. Favor grows with the log of total rep earned, and
  rep gain is ×(1 + favor/100). So an install banks this run's rep as favor and speeds up the
  rest, while the rep still needed stays the same (`installNowEstimate`). BN10's BitRunners at
  106K of 462K: 0 → 83.6 favor, 6.0h → 3.4h, including `grindInstallOverheadMinutes` (10) of
  recovery. Every favor-plan faction being ground is measured (`measureGrinds`): the player's work
  target and each sleeve's faction, from actual rep growth over 10 minutes (`measuredRepPerMin`),
  so share and every worker count. They run in parallel, so an install pays when the *last* one to
  finish finishes sooner. This holds in every mode: when it pays and nothing is pending, the
  cheapest buyable augmentation is bought so the install can happen (`pickInstallEnabler`). Rep
  toward an augmentation's own requirement never counts, because an install wipes it; only favor
  targets accumulate. An earlier rule held every install until all targets were met; that's the
  slow way, because each run's first rep banks the most favor.
- `tools/status.js` shows the grind: rep/min, time to the favor target, and what installing now
  would do.
- **The Hacknet builds** (the install loop isn't active), and share runs for the player's and the
  sleeves' faction work.
- Switch with `run tools/set_scheduler_approach.js FACTION_GRIND`. Automatic switching is planned.

**Train or grind** (`factions/training_plan.ts`, `planTraining`). Rep from work is
linear in the stats it uses, while each level costs exponentially more exp, so some training
first can reach a target sooner. The planner works in 5-minute chunks. Each round tries every
stat for 1 to 6 more chunks (levels floor, so one chunk can show nothing) and keeps the choice
that cuts total time most. It stops when nothing saves time, or at 10 hours.
`tools/train_eval.js [faction]` runs it with the real formulas and reports:
- rep/min from `factionGains` for each work type the faction offers, at its favor;
- exp/min from `gymGains` (the best gym per stat) and `universityGains` (Algorithms,
  Leadership);
- levels from `calculateSkill`.

Nothing is wired to act on it yet. Exp earned while grinding and sleeves' shared exp aren't
counted, which biases the plan toward grinding.

## Buying sleeves and memory (BitNode 10)

`sleeve_daemon.ts`, via `decideSleeveInvestment`, spends `investSpendFraction` (0.5) of the cash
above the shared savings target:
- **A new sleeve from The Covenant** (`ns.sleeve.purchaseSleeve`, BitNode 10 only; members only),
  when `getSleeveCost()` fits. The game's source (`SleeveCovenantPurchases.tsx`) says it costs
  $10T × 10ⁿ, where n is the number already bought, at most 5. It needs BN10, membership and cash,
  with no rep. A refusal's message is logged once per change and shown in the status.
- **Both last** beyond BN10. Memory is never reset: `Sleeve.prestige` sets sync to at least the
  memory value. The count is min(3, SF10 level + (1 in BN10)) + `sleevesFromCovenant`, so
  finishing BN10 turns its free sleeve into Source-File 10's, and every sleeve with its memory
  carries over.
- **Then one memory upgrade** at a time for the sleeve with the least memory
  (`upgradeMemory`, `getMemoryUpgradeCost`), up to 20 per tick. Memory is the sync a sleeve keeps
  through an install.

Getting The Covenant's invite back after an install is the faction daemon's job: combat stats
through `pursueWantedInvites`.

## Sleeves train for the gang's karma crime

Sleeves start each BitNode with reset stats. In BN10's second run, five sleeves were on Homicide
at low success, with about 11.6h to go. In the karma phase each sleeve now gets the player's
comparison (`sleeveTrainingPaysOff`, which uses `trainingPaysOff`):
- **Stat:** the one whose +10 levels raise the crime's chance most (`gangTrainingStat` with the
  sleeve's own `crimeSuccessChance`).
- **Gym time:** gym exp at Powerhouse Gym, scaled by the sleeve's sync, with `calculateExp` for
  the levels.
- **Time left:** the remaining karma at today's *total* rate, from monitoring's karma gauge over
  10 minutes, or the player's crime alone without that data.

The sleeve trains (`gym` goal: travel to Sector-12, then `setToGymWorkout`) when its crime after
training earns more karma in the time left than crime now. It's re-decided every tick. Its chance
only rises while training, so the decision doesn't flip back and forth.

## Commands queued by Claude: `src/claude/commands.txt`

`reloader.ts` runs commands queued in the repo (`runQueuedCommands`, `pendingCommands`).
`src/claude/commands.txt` is copied to `dist/` and pushed by filesync like any `.txt`. Its format
is `{"commands": [{"id", "script", "args"?, "note"?}]}`. Each check, every id not yet in
`/var/claude_commands_done.txt` is run with `ns.run(script, 1, ...args)` and echoed to the
terminal as `[Claude] Ran ...`. Only `tools/*.js` and the managed daemons are allowed (anything
else is refused and reported). A command that can't start for lack of RAM is retried for 30 checks.
Ids are never reused: add new entries, don't edit old ones.

## Sleeves with no rep left to earn train for the player

The game refuses two sleeves at one faction (`setToFactionWork`; a sleeve may share the player's
faction). So once every rep target has a worker, the remaining sleeves train (`trainingFor`,
`playerTraining`). The player gets a share of their exp, scaled by sync:
- **Gym** on the combat stat a wanted invite waits on (the faction daemon's
  `inviteAction "...: gymWorkout <stat>"`).
- **Otherwise the study config's class** (Algorithms at ZB), for hacking. Hacking contracts earn
  rep in proportion to hacking level.

Below $100M cash they commit money crimes instead, since classes and the gym cost money. Goals
are re-decided every tick, so a new rep target (say, a faction just joined) takes a training
sleeve back to faction work. The hacknet puts Improve Studying first while sleeves study.

## Sleeve augmentations

`sleeve_daemon.ts` buys augmentations for sleeves (`buySleeveAugs`, `pickSleeveAug`) in any BitNode
with sleeves. It runs after Covenant sleeves and memory, within the same `investSpendFraction` of
cash above the savings target. It takes the cheapest augmentation that raises a multiplier sleeves
use (`SLEEVE_USEFUL_STATS`: skills, exp, faction rep, crime, work money), up to 20 per tick, for
sleeves with no shock (the game requires it). The game's source shows a player install doesn't
clear them (`prestigeAugmentation` doesn't call `Sleeve.prestige`); only a new BitNode does. Each
purchase resets that sleeve's exp. The status shows each sleeve's count.

## Saving for a Covenant sleeve

In BN10, as a Covenant member, the faction daemon makes the next sleeve the shared savings target
once it's within `sleeveSaveMinutes` (480, 8 hours) of income (`sleeveSavings`). Every spender holds back,
including the faction daemon's own augmentation buying (The Red Pill still comes first). Installs
wait, and `sleeve_daemon.ts` buys the sleeve with the full balance (savings reason
`SLEEVE_SAVINGS_REASON`). Each sleeve costs 10× the last ($10T, $100T, $1Q, $10Q, $100Q), so the
later ones only come within reach once income is in the hundreds of trillions per minute.

## Nothing ends a BitNode on its own

Finishing a BitNode is the player's call. BN10 is replayed partly to buy Covenant sleeves before
leaving. Nothing calls `destroyW0r1dD43m0n`, and `backdoor_daemon.ts` excludes `w0r1d_d43m0n`
(`selectBackdoorTargets`), since backdooring it is the other way a BitNode ends. Before that
exclusion, an automatic Red Pill install plus enough hacking level would have had the backdoor
daemon end the BitNode by itself. Scheduler and hacknet targets need `maxMoney > 0`, and
`w0r1d_d43m0n` has none, so it's never hacked either.

## Corporate factions: jobs, sleeves and Company Favor

One sleeve per faction means more sleeves on rep needs more factions. The corporate factions
(ECorp, MegaCorp, …) invite at a company-rep threshold and sell strong augmentations no other
faction does.
- **The faction daemon** (`gatherCompanyTargets`, `pursueCompanyTargets`, default on) looks at
  every corporate faction not joined that sells a useful augmentation not owned. It applies at
  the employer each tick (`applyToCompany`), which is how a job is got and how promotions happen;
  both are logged. It publishes `companyTargets` (rep against the invite's
  `companyReputation` requirement, nearest first) in `/var/faction_reps.txt`.
- **Sleeves** (`company` goal) work those companies after faction rep and before training. One
  sleeve per company, which the game's `setToCompanyWork` enforces, and only where the player
  holds a job. Each invite won becomes a faction rep target, which pulls a sleeve onto it.
- **The hacknet** buys **Company Favor** (+5 favor at that company for the rest of the BitNode)
  for the nearest company target while nobody's training. Favor speeds up company rep the way it
  does faction rep.
- **Status** shows `company rep toward invites: …`.

## Root and backdoors after an install

An install removes root access and backdoors from every server, but the supervisor's saved
`rootStatus: ROOTED` was sticky: `computeRootStatus` never downgrades it. After an install the
rooter (which nukes only ROOTABLE servers) never re-nuked, the backdoor daemon crashed on servers
it had no root on, and lost backdoors were never redone, since `backdoorInstalled` was still true.
`loadStateFromDisk` now checks each saved server against the game (`hasRootAccess`,
`getServer().backdoorInstalled`). Every install restarts the supervisor, so this covers each one.
The scheduler and backdoor daemon also check `hasRootAccess` themselves before acting, and a
failed `installBackdoor` no longer crashes the daemon.

## Sticky scheduler target; staying in a BitNode

- **`keepTarget`:** a new top pick from target_selector only replaces the scheduler's target after
  it's been held 20 minutes (`TARGET_MIN_HOLD_MS`). It switches at once if the current target
  loses root, or with `targetOverride`. After an install, rising hacking level re-ranks servers
  every few minutes, and retargeting each time restarted prep from scratch. BN10's second run
  fired 2 batches in 31 minutes and earned $0 from hacking.
- **`pursueRedPill`** (`/etc/faction.txt`, default true): when false, The Red Pill is dropped from
  the faction daemon's catalog. That removes it as a rep target, from the favor plan, from
  priority work and from savings, so a BitNode kept on purpose (BN10 for Covenant sleeves) isn't
  ground toward its end.

## Targets ranked by money, discounted for prep

`target_selector.ts` weights each server as maxMoney × hack chance at min security
(`chanceWhenPrepped`) × `prepDiscount`. `prepDiscount` is H ÷ (H + prep), with H = 30 minutes,
so it's 1 for a prepped server and falls smoothly without reaching 0. Prep is estimated
(`prepTimeEstimate`) as one weaken at current security plus 2 rounds at min security. The old
maxMoney ÷ minSecurity placeholder remains as the fallback. An earlier discount hit 0 once prep
filled the horizon. That ranked every big server last (ecorp at security 99 after an install),
so none was ever prepped and none ever ranked higher, a chicken-and-egg that kept BN10 batching
$1–5B servers at hacking 6871.

Batches fire about once a second whatever the target, and a big fleet keeps many in flight, so a
prepped server earns in proportion to its money; weaken time only matters for the one-time prep.
The placeholder ignored prep: after an install it sent the scheduler to ecorp and megacorp, whose
prep outlasted the time to the next install, so hacking earned $0. Ranking by money per weaken
time then overcorrected to foodnstuff ($50M): 128 TB idle at $1.8B/min.

## The install-loop flag means "an install is near"

`/var/install_loop.txt`'s `active` is true only while something is pending, or the
saved-for augmentation is within the short `maxFocusWaitMinutes` cap. It used to be true
whenever anything was left to buy, so during a long save (BN10: 9.3h for QLink) the Hacknet,
wiped by the last install, stayed at 0 servers. Under its income policy the Hacknet also ignores
the savings target, like gang equipment, since its spending is already capped at `incomeShare`
(5%) of income.

## Multi-target batching

The scheduler batches up to `MAX_TARGETS` (24) targets at once (`selectTargets`, `hwgw.ts`). They
come from `rankedTargets`: target_selector's ranking, rooted servers only, with the stock target
first in STOCK_TARGETING. A `targetOverride` means that one target alone. Each tick the targets
go best first:
- **Not yet prepped:** a non-blocking `prepStep`, sized by `prepThreadsNeeded` (just the weaken or
  grow threads that step needs, capped by free RAM). The target is skipped until that step lands.
- **Prepped:** a batch. A batch that doesn't fit means the fleet is full this tick, so the loop
  stops.
- **Prep runs only** until a target is first ready, and again after a batch reports drift, since
  mid-batch money dips by design.
- **The 20-minute hold** only protects a target still being prepped. A prepped small target gives
  its slot to a better-ranked one at once; the hold had kept 7 small targets while ecorp waited.
- **target_selector scans the network itself** (`scanNetwork`) and checks each server live: NPC,
  hacking level met, money > 0. The supervisor's list and cached eligibility lagged (crawler
  pushes timing out, hacking level stale after an install), which left ecorp, megacorp and blade
  out of the ranking entirely at hacking 6845.

Before this, the blocking `prep()` tied the scheduler to one target. That capped income at what
one server can give: BN10 ran at 1% of 137 TB on the-hub at hacking 6541. Target ranking now
scores hack chance at **minimum** security (`chanceWhenPrepped`, formulas). After an install
ecorp sits at security 99, about 1% chance at current security, so it had ranked about 100×
too low. Status warns when batches fire while the fleet is under 30% used, and lists every
batched target.

**Root in the target selector (scorer v4).** The game reports 0% hack chance for a server
without root. megacorp, ecorp and blade (5 ports each) stayed unrooted after an install: the
openers came back while the supervisor's root records were stale, and the rooter only runs on
triggers. So they scored 0 all run. `target_selector.ts` now roots any eligible server the owned
openers allow (`root` from `rooter.ts`), and scores hack chance as if rooted; the scheduler only
uses rooted targets regardless. The ranking file records `scorer` and per-server `factors`
(max money, chance, prep discount). `status.js --verbose` shows both, plus the three richest
servers' rank, root and security, so a big server sinking out of view is visible.

**Programs ignore the savings target.** `program_shopper.ts` buys port openers and Formulas.exe
with any cash, not just cash above the savings target, because they gate rooting and every
formula. A $126T QLink save held back HTTPWorm and SQLInject for a whole run. Meanwhile the study
daemon didn't write them, since cash "could buy" them, so megacorp, ecorp and blade could never
be rooted. Status raises an ERROR for any missing opener while cash is at least $1B, and
`--verbose` lists the programs owned.

**Several batches per target per tick** (`batchesPerTick`, `hwgw.ts`): as many 4-action windows
(4 × `spacingMs`) as fit in the 1 s tick, each batch offset by one window so they land in order.
At spacing 200 that's 1, as before; at 50 it's 5. One per tick left a 2 PB fleet at 1% use, with
BN10's hacking down to $39T/min.

## Hash spending: a decision order, fed by the scheduler

`hacknet_daemon.ts` buys hash upgrades through `chooseHashUpgrade` (`hacknet_decisions.ts`). It
takes the first step that applies:
1. **Improve Gym Training / Improve Studying,** only while a goal is blocked on that stat and
   someone trains it. Gym counts while the faction daemon trains for an invite or karma, while a
   sleeve has a `gym` goal, or while a study-daemon gym session meets an invite's combat
   requirement. Studying counts in GROW_STATS, or while an invite needs hacking.
2. **Company Favor,** while sleeves work toward a corporate invite.
3. **Reduce Minimum Security on the top earner,** only while its hack chance is under 95%.
4. **Increase Maximum Money on the top earner** (+2% per level, compounding).
5. **Sell for Money,** past `hashDrainAboveFraction` of capacity while saving for something
   costlier.

Hashes are saved for the first applicable step rather than spent lower down. Cache is bought
when that step costs more than the sell line. All these upgrades, and hashes themselves, reset
at an install, so nothing is held back beyond that.

The "top earner" comes from the scheduler, which writes `/var/scheduler_targets.txt` every 5 s:
each target's state, batches in the last minute, and planned take per batch (hackFraction × max
money × chance). `tools/status.js` shows the income per target and its share.
`hashSpendTargetOverride` still forces a server.

This replaced a fixed priority list plus patches: an activity reorder, Company Favor first, and
overflow only above 90% to a configured upgrade. That spent every hash on Improve Studying at
hacking 13,900, so maximum money was never bought. The `hashSpendPriority`,
`overflowHashUpgrade` and `hashDrainUpgrade` keys are no longer read.

## The bridge: two-way Remote API (`build/bridge.mjs`)

`npm run watch` runs `build/bridge.mjs` as `watch:remote`, in place of bitburner-filesync. The old
one is still available as `watch:remote:filesync`, and only one Remote API server can be connected.
It pushes `dist/` on connect and on every change or delete, and fetches the definitions file
(ignoring anything under 10 KB). Every 10 s it copies the game's `var/` files, except
`var/supervisor/`, into `./game/` (gitignored), rewriting only changed files;
`game/.last_pull` records each pull. Tools write output for it under `/var/claude_out/`, for
example `run tools/status.js --verbose --out /var/claude_out/status.txt`. Queued commands plus the
mirror give Claude a read/write loop with the game. `BRIDGE_PORT`, `BRIDGE_MIRROR` and
`BRIDGE_DEFS` exist for testing against a fake game client.

## Drift: streaks, not single readings

Batches are planned from per-thread figures (`hackAnalyze`, `growthAnalyze`), not live money.
Grow is sized for the fraction a hack really takes, since one thread can exceed `hackFraction` at
high hacking level. Drift is judged by `driftVerdict` from one reading per target per tick:
- **Security more than max(1, 5% of min) above min:** drift at once.
- **Any other off reading:** only adds to a streak, and 10 in a row (`DRIFT_STREAK_TICKS`) means
  drained. A mid-batch dip, where a hack has landed and its grow hasn't, lasts well under a second.

Reading live state per batch had flagged about one drift a second across all targets in BN10,
each idling a target for a full prep. That was most of the gap between planned $1,134T/min and
actual $735T/min. The scheduler logs one `Batch summary (60s)` line per minute instead of a line
per batch, which had rotated its log every 2 minutes. Status parses the summary.

## Phases, and configs that hold only overrides

- **Phases** (`system/phase.ts`): `faction_daemon.ts` writes `/var/phase.txt`
  every tick from the game (`derivePhase`), working toward the BitNode's finish line:

  | Phase | When | What it does |
  |---|---|---|
  | GANG | A gang is possible (BN2 or SF2) and not yet created | Karma, then the gang |
  | FACTION_GRIND (favor) | No faction (other than the gang's) takes donations | Grinds the one faction closest to donation favor (`donationTarget`); installs only when that banks it. Share runs on at least 60% of the fleet, since reputation is the bottleneck and hacking money can't buy it yet |
  | AUGMENTS (multiply) | Donations are open | Donations and installs build the hacking multiplier |
  | DAEDALUS | With `pursueRedPill`: the hacking multiplier can reach `finishHackingLevel` (2500) within one stint of `finishExpBudget` (3e11) experience (`requiredHackingMult`; 3e11 is about 6 hours at BN12's measured rate), or Daedalus is joined | No installs except ones that bank Daedalus favor or install The Red Pill. Only The Red Pill is bought. The work slot studies until the invite, then earns Daedalus reputation, and cash is held for the invite |

  Each phase's behavior is in `phasePolicy`. The earlier version had two phases (GANG, then
  AUGMENTS for good). It installed every 15–20 minutes for whatever was affordable, including
  combat augmentations with combat stats under 10. In 15 hours of BN12 it never made a faction
  donatable, and it had no notion of the finish line.

  `readApproach` uses an explicit `approach` in
  `/etc/scheduler.txt` when set (`set_scheduler_approach.js NAME`), else this BitNode's phase
  file (one older than `lastNodeReset` is ignored), else HACK. `set_scheduler_approach.js AUTO`
  removes the override. Manual modes had carried FACTION_GRIND into a fresh BitNode, left GANG on
  after the gang existed, and missed AUGMENTS.
- **Overrides-only configs** (`loadJsonConfig`): nothing is written when a config file is missing,
  and keys equal to their default are stripped from the file, which is rewritten without them.
  Changed code defaults therefore always apply, and the file shows only what was set on purpose.

**System series** (`recordSystem`, `monitoring_daemon.ts`):
- **Hacking pipeline:** `planned_hacking_per_min`, `batches_per_min`, `drifts_per_min` (the scheduler adds `driftsLastMin` to its targets file), `targets_batching`, `targets_prepping`, `top_target_share_pct`.
- **Fleet:** `fleet_used_pct`.
- **Phase and progress:** `phase` (Approach number), `savings_target`, `augs_installed`, `augs_pending`.
- **Finish line:** `hacking_mult` against `required_hacking_mult`, `favor_target_pct` (reputation
  toward the favor target), `best_favor`, `donatable_factions`.
- **Installs:** `/var/install_history.txt` (the newest 200, archived to
  `game/archive/install_history.jsonl`). One line per install, with:
  - the phase and its reason
  - the augmentations installed
  - minutes since the previous install
  - hacking level and multiplier against the target
  - favors and the favor plan
- **Sleeves:** `sleeves`, `sleeves_on_faction`, `sleeve_avg_shock`.

These are for judging a change from its trend, not one snapshot. All of them come from the files the daemons already publish, plus one network scan. They're mirrored by the bridge, so Claude can read them directly.

## The network daemon replaces the server registry

`network_daemon.ts` roots every server the owned openers allow, writes `/var/network.txt`
(`snapshotNetwork`: path, kind, root, backdoor, organization, RAM, money, level, ports) and
re-ranks targets (`target_selector.ts`'s `rankTargets`), every 10 s, all from the live game.
`crawl_servers.js`, `rooter.js` and the supervisor's dispatch trigger are gone.
- **Scheduler and share** take worker hosts from a live scan (`liveWorkerHosts`).
- **Backdoor and stock-target daemons** read `/var/network.txt`.
- **The purchased-server daemon** asks `ns.cloud` directly.

The registry was a crawled cache kept over RPC and on disk. It went stale across installs:
servers stuck "rooted", hacking level lagging so the best targets went missing, deleted servers
crashing daemons, crawler pushes timing out. The supervisor now serves only the player snapshot.
Its registry handlers have no callers left and can go with a proto change.

**The reloader keeps state.** It saves each daemon's fingerprint by pid to
`/var/reloader_state.txt`. A new reloader seeds its tracking from that file (`seedTracked`), so
code that changed while none was running is still picked up. A daemon with no saved fingerprint
is restarted once, since its code version can't be known. Before this, a reloader started after
a change recorded the new code as current for processes still running the old version: the log
rotator kept running without its reloader watchdog, and the reloader stayed down after its next
self-exit.
