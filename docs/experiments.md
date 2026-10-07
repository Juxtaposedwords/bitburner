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

**Measurements planned:**
- The player's work target, and the donation target's reputation per minute.
- Karma per minute from the sleeves alone, and the time to the gang.
- The time from the run's start to donations opening, compared with run 2 (about 15.5 active hours).
