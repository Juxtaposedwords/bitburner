import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["workForFaction"]>[0];
type FactionWorkTypeType = Parameters<NS["singularity"]["workForFaction"]>[1];
type CityNameType = Parameters<NS["singularity"]["travelToCity"]>[0];
type GymLocationNameType = Parameters<NS["singularity"]["gymWorkout"]>[0];
type GymTypeType = Parameters<NS["singularity"]["gymWorkout"]>[1];
type UniversityNameType = Parameters<NS["singularity"]["universityCourse"]>[0];
type CourseNameType = Parameters<NS["singularity"]["universityCourse"]>[1];

const done = (ok: boolean): fs_pb.Done => ({ ok, detail: "" });

/** WorkService: the player's work slot - what's running, faction work, travel, gym, study, stop. */
export function createWorkHandlers(ns: NS): fs_pb.WorkServiceHandlers {
  return {
    Snapshot: (req) => ({
      currentWorkJson: JSON.stringify(ns.singularity.getCurrentWork() ?? null),
      workTypes: (req.factions ?? []).map((faction) => ({ faction, types: ns.singularity.getFactionWorkTypes(faction as FactionNameType) })),
    }),
    WorkForFaction: (req) => done(ns.singularity.workForFaction(req.faction as FactionNameType, req.workType as FactionWorkTypeType)),
    Travel: (req) => done(ns.singularity.travelToCity(req.city as CityNameType)),
    Gym: (req) => done(ns.singularity.gymWorkout(req.location as GymLocationNameType, req.gymType as GymTypeType)),
    Study: (req) => done(ns.singularity.universityCourse(req.university as UniversityNameType, req.course as CourseNameType, false)),
    Stop: () => done(ns.singularity.stopAction()),
  };
}
