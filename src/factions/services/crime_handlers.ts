import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type CrimeTypeType = Parameters<NS["singularity"]["commitCrime"]>[0];

/** CrimeService: committing a crime (it repeats on its own). */
export function createCrimeHandlers(ns: NS): fs_pb.CrimeServiceHandlers {
  return {
    Commit: (req) => {
      ns.singularity.commitCrime(req.crime as CrimeTypeType);
      return { ok: true, detail: "" };
    },
  };
}
