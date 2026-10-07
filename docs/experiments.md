# Experiments

Changes measured before and after on a live run. Times are UTC.

## 2026-10-06: the player works toward donation favor during GANG (BN12 run 3)

**Hypothesis.** A run's length is set by when donations open. In BN12 run 2, everything after donation
favor took about 2.6 hours, but the GANG phase took about 7.5 hours with the player on Homicide, and favor
work only started after it. Putting the player on the donation target from the start, while the sleeves
earn the gang's karma alone, should open donations hours sooner without much delay to the gang.

**Change.** `PhasePolicy.playerKarma` is false: in GANG, only the sleeves chase karma. The GANG phase also
gets `donationTarget`, `grindFactions` and share at 60%. The player commits the crime only when there are
no sleeves.

**Before (22:45, run 3 about 4.9 h in, GANG phase):**
- Karma −14,666, falling 200 a minute (the player's 60 plus about 140 from the sleeves) → gang in about
  3.3 h.
- No favor work: Netburners favor 17 (1,245 rep, +11 a minute), The Black Hand favor 20.5. Hacking 728.

**Correction (22:50).** The first version sent the player to Slum Snakes, the faction the gang is created
with. A gang's faction takes no donations, so that work was wasted. The faction daemon now leaves out the
gang's future faction (`gangFactionFor`), and the player works for The Black Hand: favor 20.5, 2,059 of
544,596 rep.

**After, 30 minutes (23:19):**
- **Karma:** −20,994, falling about 186 a minute from the sleeves alone, against about 215 with the player
  (22:35–22:45). The gang is about 2.95 h away (about 02:16), roughly 13 minutes later than before.
- **Favor:** three installs in GANG, at 22:59, 23:07 and 23:18. Each bought one cheap augmentation through
  `pickInstallEnabler`, because `grindInstallPays` judged that banking favor finishes the grind sooner.
  - The Black Hand's favor went from 20.5 to 27.4, and Netburners' from 17 to 28.2. Before the change,
    neither had moved for the whole run.
  - The cost: each install resets hacking to level 1 (728 before) along with money. The sleeves' karma
    showed only a one-minute dip at each install.
- **Still to measure (a few hours in):** the time from the run's start to donations opening, compared
  with run 2 (about 15.5 active hours).

**After, 2.5 hours (01:19):**
- **Karma:** −46,467. It fell 211 a minute over the last 2 hours, as fast as the player and sleeves managed
  together before the change, so giving up the player's crime cost the gang nothing. The gang is about
  36 minutes away (about 01:55).
- **Favor:**
  - Netburners went from 17 to 75.1, The Black Hand to 31.3.
  - Installs come every 17–21 minutes, each banking 7.5–9 favor for Netburners. The gain slowly shrinks
    as the gap between installs grows.
  - At this pace, the 150 favor that opens donations is about 10 installs (about 3.5 h) away: around
    04:50, about 11 hours into the run, against about 15.5 active hours in run 2.
- **Hacking:** resets to 1 at each install, and is back to about 700 by the next one.

**Result (05:15):** donations opened at **05:02, 11.1 hours into the run** (it started at 17:54), against
about 15.5 active hours in run 2, so about 4.4 hours sooner.
- **Gang:** formed at 01:51, 7.95 hours in, after the karma reached −54,000. That's about as long as run 2's
  GANG phase (about 7.5 h, which included the player's crime), so the player's favor work cost the gang
  essentially nothing.
- **FACTION_GRIND:** ran 01:52–05:02, with installs at 01:52, 02:17, 03:01 and 05:00. The gaps grew to
  118 minutes as rep needed per install rose. Netburners went from 81.9 to 159 favor.
- **Phase now:** AUGMENTS, with the hacking multiplier at 2.55 of the 3.87 required. Run 2 needed about
  2.6 hours from donations to the finish.

**Pause.** The game was closed from 05:18 to 18:37 on 10-07; active-time figures leave that out. On
restart, the augmentations bought in AUGMENTS were installed (18:38). That took the hacking multiplier from
2.55 to 5.78, past the 3.87 required, so the run went straight to DAEDALUS after 11.4 active hours. In
run 2, finishing took about 18.1 active hours in total.

**Measurements planned:**
- The player's work target, and the donation target's reputation per minute.
- Karma per minute from the sleeves alone, and the time to the gang.
- The time from the run's start to donations opening, compared with run 2 (about 15.5 active hours).

## 2026-10-07: predictions for BN12 run 4

**Changes since run 3:**
- The player works toward donation favor from the start of the run, not from hour 4.9 as in run 3.
- The player turns to karma crime once donations are open (`playerChasesKarma`).
- Run milestones are recorded in `/var/run_milestones.txt`, archived to `game/archive/run_milestones.jsonl`.

**Sleeves.** A simulation by the game's formulas (kept out of the repo, as the game's code is for testing
only) compared sleeve policies for a gang from sleeves alone:

| Policy | Gang after |
|---|---|
| Homicide from the start | 15.7 h |
| Gym until a 20% success chance, then crime | 11.8 h |
| Run 3's schedule (gym for 4.7 h, then crime) | 11.3 h |
| Recovery to shock 80, then 2 at the gym and the rest on crime | 11.6 h |

- Sleeves start every BitNode at 100 shock, and all of their experience is scaled by (100 − shock)/100, so
  nothing builds their stats quickly at first. The current train-first behavior is about as good as any
  policy tried.
- The simulation is slightly pessimistic: at a 30% chance it gives about 125 karma a minute, against
  150–210 observed.
- No sleeve change.

**Predicted for run 4:**
- **Donations:** about 6.5–7 h, against 11.1 h in run 3.
- **Gang:** about 9 h, against 7.95 h. The player only joins the crime once donations are open, and until
  then the sleeves are training.
- **DAEDALUS:** about 9–10 h, against 11.4 active hours.

**Stall found at the end of run 3 (21:26 on 10-07).**
- The run had sat in DAEDALUS since 18:38: hacking 3,207 (3,121 needed), $1.98 quadrillion.
- The Daedalus invite also needs 31 installed augmentations, and there were 24. DAEDALUS buys only The
  Red Pill, so the invite could never come.
- **Fix:** the phase now waits for the count (`daedalusAugsShort`). It stays in AUGMENTS, buying any
  augmentation, until the count is met.
- About 2.9 h lost; run 3's total includes it.

**Known start-of-run losses in run 3:**
- **No boot for 7 minutes after the finish (17:54–18:01).** Boot's record (`/var/claude_out/boot.txt`)
  only started at 18:01, so the next finish will show whether the finish's call to `boot.js` runs at all.
- **No faction daemon for 38 minutes (18:19–18:57).** It's 100.8 GB and waited for $7.9M to buy
  `daemons-0`. No early hacked server fits it: the 128 GB ones need 3 or more ports.
