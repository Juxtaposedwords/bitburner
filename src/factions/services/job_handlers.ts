import { NS } from "@ns";
import * as pb from "factions/rpc/job";

type CompanyNameType = Parameters<NS["singularity"]["applyToCompany"]>[0];
type JobFieldType = Parameters<NS["singularity"]["applyToCompany"]>[1];

/** JobService: company jobs - applying (and promotions), working, quitting. */
export function createJobHandlers(ns: NS): pb.JobServiceHandlers {
  return {
    ApplyToCompany: (req) => ({ job: ns.singularity.applyToCompany(req.company as CompanyNameType, req.field as JobFieldType) ?? "" }),
    WorkForCompany: (req) => ({ ok: ns.singularity.workForCompany(req.company as CompanyNameType) }),
    QuitJob: (req) => {
      ns.singularity.quitJob(req.company as CompanyNameType);
      return { ok: true };
    },
  };
}
