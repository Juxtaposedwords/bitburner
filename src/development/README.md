# README

Goals:
1. Practice funcioanl programming
2. Work on using a file-based approach

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
