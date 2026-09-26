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
- **`tools/program_shopper.ts`** — one of three places that reference
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

### Pre-install wind-down: `development/libraries/install_handshake.ts`

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
- Both are the second and third files (after `tools/program_shopper.ts`)
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
  `decideMemberTask` maximizes `moneyGain` for most members;
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
  `development/libraries/status.proto`'s exact shape, confirmed as a supported pattern in
  `protos/build.mjs`'s `serviceNodes.length === 0` branch): `enum GangPosture { CONSOLIDATE = 0;
  GROWING = 1; }`. `GangConfig.posture` in `/etc/gang.txt` stores the **string** form
  (`"CONSOLIDATE"`/`"GROWING"`), not the raw numeric enum — every other config file in this
  codebase is meant to be hand-edited as readable JSON, and a bare `"posture": 1` would break
  that. `parsePosture` converts it to the real `GangPosture` enum at the point of use, the same
  boundary-casting pattern `hacknet_daemon.ts` already uses for `HashUpgradeName`/`FactionNameType`.
  Defaults to `"CONSOLIDATE"` — opt into `"GROWING"` explicitly, same "ask before hard-to-reverse"
  spirit as `autoInstall`/`autoPurchaseAugmentations` defaulting off in `faction_daemon.ts`.
- **`decideTerritoryWarfareAssignment`** (`gang_decisions.ts`) carves `config.territoryWarfareMembers`
  members off the front of the roster onto `"Territory Warfare"` whenever posture is `GROWING`
  and the circuit breaker (below) hasn't tripped — zero otherwise. The remaining members still go
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

## Monitoring: `monitoring_daemon.ts` + `tools/monitor.ts` (`/var/monitoring/`)

Where money comes from and goes, over time, without digging through daemon logs. It's a minimal
time-series store, not an event log. The existing logs still answer "what happened" (which
augmentation was bought, and exactly when); this answers "what's the trend."

- **Storage (`development/libraries/timeseries.ts`)**: one small JSON file per series at
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
