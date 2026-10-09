import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type CrimeTypeType = Parameters<NS["singularity"]["getCrimeStats"]>[0];

/** CrimeInfoService: every crime's karma, time, kills and current success chance. */
export function createCrimeInfoHandlers(ns: NS): fs_pb.CrimeInfoServiceHandlers {
  return {
    Snapshot: () => ({
      crimes: Object.values(ns.enums.CrimeType).map((crime) => {
        const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
        return { crime, karma: stats.karma, timeMs: stats.time, kills: stats.kills, chance: ns.singularity.getCrimeChance(crime as CrimeTypeType) };
      }),
    }),
  };
}
