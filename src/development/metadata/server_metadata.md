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
`charisma`, `intelligence`), `singularityAvailable`, and `money` (added
for `hacknet_daemon.ts` — see below) — still not a full mirror of
Bitburner's `Player` object (no `karma`, `jobs`, `factions`, `mults`,
...), extended only as real consumers need more. `PatchPlayerMetadata` (same "ignore
explicitly-undefined fields" merge semantics as `SupervisorService`'s
`PatchMetadata`, no key needed since there's only ever one player) lets a
one-shot script push a fact into player state once —
`detect_capabilities.ts` is the only place that calls the expensive
`ns.getResetInfo()`, once, and patches `singularityAvailable` in via this
RPC, rather than every consumer re-deriving it. `SupervisorState.player`
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
`loadStateFromDisk` for server metadata. `boot.ts` uses this to avoid
re-running `detect_capabilities.js` (and re-paying `ns.getResetInfo()`'s
1 GB) on every boot: it queries `GetPlayerMetadata` first, and only
launches the detector if `singularityAvailable` is still unset.

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
- **Worker hosts: `home` and Hacknet servers reserved, with an early-game
  home fallback.** Hack/grow/weaken threads run on rooted servers other
  than `home` and `ServerKind.HACKNET` hosts (`listWorkerHosts`, via
  `ListServers` — purchased/`ns.cloud` servers count once bought). Hacknet
  servers are excluded because `ns.formulas.hacknetServers.hashGainRate`
  takes `ramUsed` as an input — running HWGW scripts on one measurably cuts
  its own hash output, undermining the entire point of
  `purchased_server_daemon.ts`'s counterpart, `hacknet_daemon.ts` (see
  below). Below `SchedulerConfig.homeFallbackHackingLevel` (default 50),
  `home` is included too, since early on it may be the only significant
  RAM source before enough is rooted/purchased elsewhere — but even then,
  `homeReservedRamGb` (default 5) always stays off-limits, so development
  keeps some headroom. At or above that hacking level, `home` reverts to
  fully reserved, same as it stays for every other purpose in this
  codebase. Both are live-patchable via `PatchSchedulerConfig`.
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
  toward" mode switch) but not implemented — only `HACK` does anything.

## Program purchasing: `ns.singularity`, gated by Source-File 4

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
- **`tools/program_shopper.ts`** — the only place that references
  `ns.singularity.*` anywhere in the codebase, kept fully isolated so its
  cost can never leak into `supervisor.ts`/`scheduler_daemon.ts`'s own
  footprint. `boot.ts` only launches it when `singularityAvailable` is
  true; a fixed 30s poll loop (not event-triggered — purchasing is gated
  by *money*, not hacking level, and SF4 ownership can't change
  mid-session) calls `purchaseTor()` (idempotent) then buys whichever of
  the five port-openers it can currently afford.

`player.ts`'s existing `ns.fileExists` detection of owned programs is
unaffected either way — that's how `portOpenersOwned` gets tracked
regardless of whether a program arrived via `program_shopper.ts` or a
manual purchase.

## Hacknet manager: `hacknet_daemon.ts`, BitNode-agnostic by construction

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
`development/libraries/config.ts`'s `loadJsonConfig` — the same helper
`supervisor.ts`/`player.ts` already use for their own `/etc/*.txt` files —
called fresh on *every* tick rather than once at startup, so hand-editing
`/etc/hacknet.txt` takes effect within one tick. This is actually a step
up from `SchedulerConfig`'s RPC-only approach: that config isn't
persisted across a `scheduler_daemon.js` restart today (pure in-memory,
patched only via `PatchSchedulerConfig`), while a file-based config
survives one for free.

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
  picks, and — only in a Server context — spends hashes on the first
  affordable entry in `config.hashSpendPriority`. For the two
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
