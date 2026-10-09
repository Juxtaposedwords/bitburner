import { NS } from "@ns";
import * as pb from "factions/rpc/aug_detail";

/** AugDetailService: each named augmentation's prerequisites and multipliers. */
export function createAugDetailHandlers(ns: NS): pb.AugDetailServiceHandlers {
  return {
    GetDetails: (req) => ({
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
