# README

Goals:
1. Practice funcioanl programming
2. Work on using a file-based approach

## Services

### Daemons

- **`supervisor.ts`** — RPC server; stores server metadata, dispatches jobs on player-state changes.
- **`player.ts`** — polls player stats, writes a snapshot to disk every 5s.
- **`log_rotator.ts`** — truncates any log file over 100KB, keeps one backup.

### One-shot jobs

- **`crawl_servers.ts`** — scans the whole network, reports each server's facts to supervisor.
- **`rooter.ts`** — opens ports and nukes every currently-rootable server.
- **`target_selector.ts`** — ranks attackable servers by a `$/sec` proxy.

### Orchestration

- **`boot.ts`** — launches the daemons, then runs one-shot jobs in dependency order.

### Tools

- **`wipe_data.ts`** — deletes `/var/log/` and `/var/supervisor/` for a clean test run.
- **`scan.ts`** — prints the network as a table with root/hacking-level status.
- **`tree.ts`** — prints a filtered directory listing of files on a server.
- **`logger.ts`** — tails and filters log files in-terminal, with per-process coloring.

## Journal

### 07/18

Ideally our priorities are:
1. Add new servers and then weaken them to the lowest possible amount.
2. Get into a loop of 
   1. Make security level as low as possible
   2. Make money as low as possible
   3. Hack lyfe

Background tasks:
1. Look at all servers, hack what you can
   * Add scanned servers to a config file


# 07/21 

Need to think more Top-Down. So let's 

## The best things in life are free

| Bitnode | baseCost (GiB) | .hack() (GiB) | read() / write() |
| ------- | -------------- | ------------- | ------ | 
| 1       | 1.6            | .1            | 0      |

### What we can store ot prevent look up cost:
1. minsecurity level
2. current security level

Axiom:
*  Prefer smaller code, which read/writes from disk. 
    *  Record state on disk.

## Fleet growth:

* Hacking a server requires:
  * Hacking level
  * Open ports

Axiom:
 * hack servers whenever you level up `hacking` or buy a port releated `.exe`.


## What i ended up doing
1. Did manual metadata implmeentation. Then vibe-coded a scheduler version which was a touch more functional.
2. Adding a logging function because it's way easier to craft a logger function for myself

## Todo:
* Maybe remove /data/logs from the tree command?
* Look for way to add .txt files of where to store
