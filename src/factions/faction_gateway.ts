import { NS } from "@ns";
import { Codes } from "system/rpc/status";
import { Deadline } from "system/deadline";
import * as fs_pb from "factions/rpc/faction_services";
import { FactionView } from "factions/faction_view";

/**
 * The faction daemon's side of its four services (faction_services.proto):
 * one snapshot per tick into a FactionView, then actions. Every call takes
 * the tick's deadline; a service that doesn't answer in time makes the
 * snapshot undefined (the tick is skipped, never half-run) or an action
 * report failure.
 */
export type FactionClients = {
  info: ReturnType<typeof fs_pb.NewFactionInfoServiceClient>;
  work: ReturnType<typeof fs_pb.NewFactionWorkServiceClient>;
  crime: ReturnType<typeof fs_pb.NewCrimeServiceClient>;
  purchase: ReturnType<typeof fs_pb.NewAugmentPurchaseServiceClient>;
};

export function factionClients(ns: NS): FactionClients {
  return {
    info: fs_pb.NewFactionInfoServiceClient(ns),
    work: fs_pb.NewFactionWorkServiceClient(ns),
    crime: fs_pb.NewCrimeServiceClient(ns),
    purchase: fs_pb.NewAugmentPurchaseServiceClient(ns),
  };
}

/** What one tick asks the services about. */
export type ViewRequest = {
  joined: string[];
  // Factions whose invite requirements matter (not joined).
  requirementFactions: string[];
  // Factions whose catalog matters beyond the joined ones.
  offerFactions: string[];
  companies: string[];
};

/** A failed call's description, for the log. */
export type CallFailure = { call: string; status?: Codes; error?: string };

export async function fetchWork(c: FactionClients, req: ViewRequest, deadline: Deadline): Promise<fs_pb.WorkSnapshot | CallFailure> {
  const res = await c.work.Snapshot({ requirementFactions: req.requirementFactions, workTypeFactions: req.joined }, deadline);
  return res.status === Codes.OK && res.data ? res.data : { call: "FactionWorkService.Snapshot", status: res.status, error: res.error };
}

/** The tick's view: info and crime snapshots on top of `work` (fetched first, for invitations). */
export async function fetchView(c: FactionClients, req: ViewRequest, work: fs_pb.WorkSnapshot, deadline: Deadline): Promise<FactionView | CallFailure> {
  const [info, crimes] = await Promise.all([
    c.info.Snapshot({ standingFactions: req.joined, offerFactions: [...new Set([...req.joined, ...req.offerFactions])], companies: req.companies }, deadline),
    c.crime.Snapshot({}, deadline),
  ]);
  if (info.status !== Codes.OK || !info.data) return { call: "FactionInfoService.Snapshot", status: info.status, error: info.error };
  if (crimes.status !== Codes.OK || !crimes.data) return { call: "CrimeService.Snapshot", status: crimes.status, error: crimes.error };
  return new FactionView(info.data, work, crimes.data);
}

export function isFailure<T>(x: T | CallFailure): x is CallFailure {
  return typeof x === "object" && x !== null && "call" in x && typeof (x as CallFailure).call === "string" && !(x instanceof FactionView);
}

/** Whether an action call went through and the game said yes. */
export function succeeded(res: { status: Codes; data?: { ok?: boolean } }): boolean {
  return res.status === Codes.OK && res.data?.ok === true;
}
