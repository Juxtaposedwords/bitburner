import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type CrimeTypeType = Parameters<NS["singularity"]["commitCrime"]>[0];

/** CrimeService (faction_services.proto): every crime's stats and chance, and committing one. */
export function createCrimeHandlers(ns: NS): fs_pb.CrimeServiceHandlers {
  return {
    Snapshot: () => ({
      crimes: Object.values(ns.enums.CrimeType).map((crime) => {
        const stats = ns.singularity.getCrimeStats(crime as CrimeTypeType);
        return { crime, karma: stats.karma, timeMs: stats.time, kills: stats.kills, chance: ns.singularity.getCrimeChance(crime as CrimeTypeType) };
      }),
    }),
    Commit: (req) => {
      ns.singularity.commitCrime(req.crime as CrimeTypeType);
      return { ok: true, detail: "" };
    },
  };
}
