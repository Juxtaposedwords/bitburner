import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

/** AugDetailService: each named augmentation's prerequisites and multipliers. */
export function createAugDetailHandlers(ns: NS): fs_pb.AugDetailServiceHandlers {
  return {
    Snapshot: (req) => ({
      details: (req.names ?? []).map((name) => {
        const stats = ns.singularity.getAugmentationStats(name) as unknown as Record<string, number>;
        return {
          name,
          prereqs: ns.singularity.getAugmentationPrereq(name),
          stats: Object.entries(stats).map(([key, value]) => ({ key, value })),
        };
      }),
    }),
  };
}
