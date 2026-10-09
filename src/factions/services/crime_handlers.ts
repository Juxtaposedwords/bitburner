import { NS } from "@ns";
import * as pb from "factions/rpc/crime";

type CrimeTypeType = Parameters<NS["singularity"]["commitCrime"]>[0];

/** CrimeService: committing a crime (it repeats on its own). */
export function createCrimeHandlers(ns: NS): pb.CrimeServiceHandlers {
  return {
    CommitCrime: (req) => {
      ns.singularity.commitCrime(req.crime as CrimeTypeType);
      return { ok: true };
    },
  };
}
