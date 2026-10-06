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

**After:** to be measured about 30 minutes and a few hours after the change:
- The player's work target, and the donation target's reputation per minute.
- Karma per minute from the sleeves alone, and the time to the gang.
- The time from the run's start to donations opening, compared with run 2 (about 15.5 active hours).
