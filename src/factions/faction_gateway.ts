import { NS } from "@ns";
import { Codes } from "system/rpc/status";
import { Deadline } from "system/deadline";
import * as fs_pb from "factions/rpc/faction_services";
import { FactionView } from "factions/faction_view";

/**
 * The faction daemon's side of its services (faction_services.proto): one
 * view per tick from their snapshots, then actions. Every call takes the
 * tick's deadline; a service that doesn't answer in time leaves no view (the
 * tick is skipped, never half-run) or makes an action report failure. The
 * one exception is crime info: without it the view has no crimes, and only
 * crime decisions wait.
 */
export type FactionClients = {
  catalog: fs_pb.AugCatalogServiceClient;
  detail: fs_pb.AugDetailServiceClient;
  standing: fs_pb.StandingServiceClient;
  invite: fs_pb.InviteServiceClient;
  work: fs_pb.WorkServiceClient;
  job: fs_pb.JobServiceClient;
  crimeInfo: fs_pb.CrimeInfoServiceClient;
  crime: fs_pb.CrimeServiceClient;
  buy: fs_pb.AugBuyServiceClient;
  install: fs_pb.InstallServiceClient;
  homeRam: fs_pb.HomeRamServiceClient;
};

export function factionClients(ns: NS): FactionClients {
  return {
    catalog: fs_pb.NewAugCatalogServiceClient(ns),
    detail: fs_pb.NewAugDetailServiceClient(ns),
    standing: fs_pb.NewStandingServiceClient(ns),
    invite: fs_pb.NewInviteServiceClient(ns),
    work: fs_pb.NewWorkServiceClient(ns),
    job: fs_pb.NewJobServiceClient(ns),
    crimeInfo: fs_pb.NewCrimeInfoServiceClient(ns),
    crime: fs_pb.NewCrimeServiceClient(ns),
    buy: fs_pb.NewAugBuyServiceClient(ns),
    install: fs_pb.NewInstallServiceClient(ns),
    homeRam: fs_pb.NewHomeRamServiceClient(ns),
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

type Res<T> = { status: Codes; data?: T; error?: string };

function failure<T>(call: string, res: Res<T>): CallFailure | undefined {
  return res.status === Codes.OK && res.data ? undefined : { call, status: res.status, error: res.error };
}

/** The first round: invitations and requirements, and the work slot - what to join is decided from these. */
export type WorkRound = { invites: fs_pb.InviteSnapshot; work: fs_pb.WorkSnapshot };

export async function fetchWork(c: FactionClients, req: ViewRequest, deadline: Deadline): Promise<WorkRound | CallFailure> {
  const [invites, work] = await Promise.all([
    c.invite.Snapshot({ factions: req.requirementFactions }, deadline),
    c.work.Snapshot({ factions: req.joined }, deadline),
  ]);
  const failed = failure("InviteService.Snapshot", invites) ?? failure("WorkService.Snapshot", work);
  if (failed) return failed;
  return { invites: invites.data as fs_pb.InviteSnapshot, work: work.data as fs_pb.WorkSnapshot };
}

/**
 * The tick's view on top of the first round: standing and the catalog, then
 * the details of every listed and pending augmentation, with crime info.
 */
export async function fetchView(c: FactionClients, req: ViewRequest, first: WorkRound, deadline: Deadline): Promise<FactionView | CallFailure> {
  const [standing, catalogFirst] = await Promise.all([
    c.standing.Snapshot({ factions: req.joined, companies: req.companies }, deadline),
    c.catalog.Snapshot({ factions: [...new Set([...req.joined, ...req.offerFactions])] }, deadline),
  ]);
  const failedFirst = failure("StandingService.Snapshot", standing) ?? failure("AugCatalogService.Snapshot", catalogFirst);
  if (failedFirst) return failedFirst;
  const standingData = standing.data as fs_pb.StandingSnapshot;
  let catalog = catalogFirst.data as fs_pb.CatalogSnapshot;
  // Pending augmentations no listed faction sells still need their stats and price.
  const listed = new Set((catalog.prices ?? []).map((p) => p.name));
  const installed = new Set(standingData.installed ?? []);
  const extra = (standingData.ownedWithQueued ?? []).filter((n) => !installed.has(n) && !listed.has(n));
  if (extra.length > 0) {
    const more = await c.catalog.Snapshot({ factions: [], extraNames: extra }, deadline);
    const failedMore = failure("AugCatalogService.Snapshot", more);
    if (failedMore) return failedMore;
    catalog = { offers: catalog.offers, prices: [...(catalog.prices ?? []), ...((more.data as fs_pb.CatalogSnapshot).prices ?? [])] };
  }
  const names = (catalog.prices ?? []).map((p) => p.name ?? "");
  const [details, crimes] = await Promise.all([c.detail.Snapshot({ names }, deadline), c.crimeInfo.Snapshot({}, deadline)]);
  const failedDetails = failure("AugDetailService.Snapshot", details);
  if (failedDetails) return failedDetails;
  return new FactionView({
    standing: standingData,
    catalog,
    details: details.data as fs_pb.DetailSnapshot,
    invites: first.invites,
    work: first.work,
    crimes: crimes.status === Codes.OK ? crimes.data : undefined,
  });
}

export function isFailure<T>(x: T | CallFailure): x is CallFailure {
  return typeof x === "object" && x !== null && "call" in x && typeof (x as CallFailure).call === "string";
}

/** Whether an action call went through and the game said yes. */
export function succeeded(res: { status: Codes; data?: { ok?: boolean } }): boolean {
  return res.status === Codes.OK && res.data?.ok === true;
}
