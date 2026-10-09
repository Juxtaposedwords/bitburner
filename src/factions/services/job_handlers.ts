import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type CompanyNameType = Parameters<NS["singularity"]["applyToCompany"]>[0];
type JobFieldType = Parameters<NS["singularity"]["applyToCompany"]>[1];

/** JobService: company jobs - applying (and promotions), working, quitting. */
export function createJobHandlers(ns: NS): fs_pb.JobServiceHandlers {
  return {
    ApplyToCompany: (req) => ({ job: ns.singularity.applyToCompany(req.company as CompanyNameType, req.field as JobFieldType) ?? "" }),
    WorkForCompany: (req) => ({ ok: ns.singularity.workForCompany(req.company as CompanyNameType), detail: "" }),
    QuitJob: (req) => {
      ns.singularity.quitJob(req.company as CompanyNameType);
      return { ok: true, detail: "" };
    },
  };
}
