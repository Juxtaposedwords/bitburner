import { NS } from "@ns";
import * as pb from "factions/rpc/crime_info";

type CrimeTypeType = Parameters<NS["singularity"]["getCrimeStats"]>[0];

/** CrimeInfoService: every crime's karma, time, kills and current success chance. */
export function createCrimeInfoHandlers(ns: NS): pb.CrimeInfoServiceHandlers {
  return {
    GetCrimes: () => ({
      crimes: Object.values(ns.enums.CrimeType).map((crime) => {
        const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
        return { crime, karma: stats.karma, timeMs: stats.time, kills: stats.kills, chance: ns.singularity.getCrimeChance(crime as CrimeTypeType) };
      }),
    }),
  };
}
