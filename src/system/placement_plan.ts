/**
 * Where boot puts every daemon, planned before anything starts: bin
 * packing over home and the rooted hacked servers, in priority order.
 * Pure - boot carries the plan out; tests check it against a BitNode's real
 * numbers.
 *
 * Boot used to place greedily, one daemon at a time: a movable daemon took
 * home while home had room, so by the time a home-only one (monitoring)
 * came up, home was full (BN9). Planned whole, home-only daemons claim home
 * first, movable ones go onto hacked servers (largest first, into the
 * smallest server that fits) with home's leftover as their fallback.
 */
export type Unit = {
  script: string;
  ram: number;
  // Can only run on home (it isn't written to run elsewhere).
  homeOnly: boolean;
  // Where it's already running, if it is: kept there.
  runningOn?: string;
};

export type Bin = { host: string; free: number };

export type Placement = { script: string; host: string; alreadyRunning: boolean };

export type PlacementPlan = {
  placed: Placement[];
  // The first unit that couldn't be fit: nothing after it is placed either,
  // so lower-priority daemons never take the room it needs.
  held?: string;
};

export const HOME = "home";

/** Packs `units` (all of them) or returns undefined; running units stay where they are. */
function pack(units: Unit[], homeFree: number, hacked: Bin[]): Placement[] | undefined {
  const bins = new Map<string, number>([[HOME, homeFree], ...hacked.map((b): [string, number] => [b.host, b.free])]);
  const placed: Placement[] = [];
  for (const u of units) {
    if (u.runningOn) placed.push({ script: u.script, host: u.runningOn, alreadyRunning: true });
  }
  const toPlace = units.filter((u) => !u.runningOn);
  // Home-only units claim home first.
  for (const u of toPlace.filter((u) => u.homeOnly)) {
    const room = bins.get(HOME) ?? 0;
    if (u.ram > room) return undefined;
    bins.set(HOME, room - u.ram);
    placed.push({ script: u.script, host: HOME, alreadyRunning: false });
  }
  // Movable units, largest first, into the smallest hacked server that fits; home's leftover last.
  for (const u of toPlace.filter((u) => !u.homeOnly).sort((a, b) => b.ram - a.ram)) {
    const fits = hacked
      .map((b) => ({ host: b.host, room: bins.get(b.host) ?? 0 }))
      .filter((b) => b.room >= u.ram)
      .sort((a, b) => a.room - b.room)[0];
    const host = fits?.host ?? ((bins.get(HOME) ?? 0) >= u.ram ? HOME : undefined);
    if (!host) return undefined;
    bins.set(host, (bins.get(host) ?? 0) - u.ram);
    placed.push({ script: u.script, host, alreadyRunning: false });
  }
  return placed;
}

/**
 * The plan for `units` in priority order: the longest prefix that packs.
 * `homeFree` is home's RAM free for daemons; each hacked bin's `free` is
 * its RAM less the daemons already running there (workers don't count -
 * they're stopped for a daemon).
 */
export function planPlacement(units: Unit[], homeFree: number, hacked: Bin[]): PlacementPlan {
  let best: Placement[] = [];
  for (let k = 1; k <= units.length; k++) {
    const placed = pack(units.slice(0, k), homeFree, hacked);
    if (!placed) return { placed: best, held: units[k - 1].script };
    best = placed;
  }
  return { placed: best };
}
