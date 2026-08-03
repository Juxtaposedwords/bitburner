const TARGET_SELECTOR_SCRIPT = "development/metadata/target_selector.js";
const ROOTER_SCRIPT = "development/metadata/rooter.js";

/**
 * Written by rooter.ts as its last action (a plain, free ns.write()); read
 * here to know when a rooting pass has finished, instead of paying for
 * ns.scriptRunning() (see server_metadata.md's RAM notes). The content is
 * opaque — only ever compared for equality, never parsed.
 */
export const ROOTER_MARKER_PATH = "/var/supervisor/rooter_last_run.txt";

/** Tells target_selector.js to recompute even though its own stored hacking level hasn't changed. */
export const FORCE_ARG = "--force";

export function changed<T>(previous: T | undefined, current: T): boolean {
  return previous !== undefined && current !== previous;
}

export type DispatchSnapshot = {
  hackingLevel: number;
  portOpenersOwned: number;
  /** Current content of ROOTER_MARKER_PATH. */
  rooterMarker: string;
};

export type Dispatch = { script: string; args?: string[] };

/**
 * Which one-shot jobs a change in state warrants. Three independent
 * signals, three independent reasons to launch:
 *
 * - Hacking level changed -> previously out-of-reach servers may now be
 *   attackable -> target_selector re-ranks.
 * - Port-openers owned changed -> previously unrootable servers may now be
 *   rootable -> the rooter goes and roots them.
 * - The rooter just finished a pass (its completion marker changed) -> it
 *   may have just rooted a server that's already within hacking-level
 *   reach, which target_selector's own hacking-level-only check can't see
 *   on its own -> re-rank anyway, forced via FORCE_ARG. Guarded against
 *   double-dispatching target_selector in the same tick as a hacking-level
 *   change, which would otherwise queue it twice.
 *
 * Returns an empty array most ticks, since these values rarely change.
 */
export function scriptsToLaunch(previous: DispatchSnapshot | undefined, current: DispatchSnapshot): Dispatch[] {
  const dispatches: Dispatch[] = [];

  const hackingLevelChanged = changed(previous?.hackingLevel, current.hackingLevel);
  if (hackingLevelChanged) dispatches.push({ script: TARGET_SELECTOR_SCRIPT });

  if (changed(previous?.portOpenersOwned, current.portOpenersOwned)) dispatches.push({ script: ROOTER_SCRIPT });

  if (!hackingLevelChanged && changed(previous?.rooterMarker, current.rooterMarker)) {
    dispatches.push({ script: TARGET_SELECTOR_SCRIPT, args: [FORCE_ARG] });
  }

  return dispatches;
}
