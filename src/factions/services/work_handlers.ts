import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];
type FactionWorkTypeType = Parameters<NS["singularity"]["workForFaction"]>[1];
type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type CompanyNameType = Parameters<NS["singularity"]["applyToCompany"]>[0];
type JobFieldType = Parameters<NS["singularity"]["applyToCompany"]>[1];
type GymLocationNameType = Parameters<NS["singularity"]["gymWorkout"]>[0];
type GymTypeType = Parameters<NS["singularity"]["gymWorkout"]>[1];

const done = (ok: boolean, detail = ""): fs_pb.Done => ({ ok, detail });

/**
 * FactionWorkService (faction_services.proto): invites, the work slot and
 * where the player is. Every call is one game call; the faction daemon
 * decides whether to make it.
 */
export function createWorkHandlers(ns: NS): fs_pb.FactionWorkServiceHandlers {
  return {
    Snapshot: (req) => ({
      invitations: ns.singularity.checkFactionInvitations(),
      requirements: (req.requirementFactions ?? []).map((faction) => ({
        faction,
        requirementsJson: JSON.stringify(ns.singularity.getFactionInviteRequirements(faction as FactionNameType)),
      })),
      currentWorkJson: JSON.stringify(ns.singularity.getCurrentWork() ?? null),
      workTypes: (req.workTypeFactions ?? []).map((faction) => ({
        faction,
        types: ns.singularity.getFactionWorkTypes(faction as FactionNameType),
      })),
    }),
    Join: (req) => done(ns.singularity.joinFaction(req.faction as FactionNameType)),
    WorkForFaction: (req) => done(ns.singularity.workForFaction(req.faction as FactionNameType, req.workType as FactionWorkTypeType)),
    ApplyToCompany: (req) => ({ job: ns.singularity.applyToCompany(req.company as CompanyNameType, req.field as JobFieldType) ?? "" }),
    WorkForCompany: (req) => done(ns.singularity.workForCompany(req.company as CompanyNameType)),
    QuitJob: (req) => {
      ns.singularity.quitJob(req.company as CompanyNameType);
      return done(true);
    },
    Travel: (req) => done(ns.singularity.travelToCity(req.city as CityNameType)),
    Gym: (req) => done(ns.singularity.gymWorkout(req.location as GymLocationNameType, req.gymType as GymTypeType)),
    Stop: () => done(ns.singularity.stopAction()),
  };
}
