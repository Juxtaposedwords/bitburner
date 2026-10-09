import { NS } from "@ns";
import { Codes } from "system/rpc/status";
import { Deadline } from "system/deadline";
import * as catalog_pb from "factions/rpc/aug_catalog";
import * as detail_pb from "factions/rpc/aug_detail";
import * as standing_pb from "factions/rpc/standing";
import * as invite_pb from "factions/rpc/invite";
import * as work_pb from "factions/rpc/work";
import * as job_pb from "factions/rpc/job";
import * as crime_info_pb from "factions/rpc/crime_info";
import * as crime_pb from "factions/rpc/crime";
import * as buy_pb from "factions/rpc/aug_buy";
import * as install_pb from "factions/rpc/install";
import * as home_ram_pb from "factions/rpc/home_ram";
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
  catalog: catalog_pb.AugCatalogServiceClient;
  detail: detail_pb.AugDetailServiceClient;
  standing: standing_pb.StandingServiceClient;
  invite: invite_pb.InviteServiceClient;
  work: work_pb.WorkServiceClient;
  job: job_pb.JobServiceClient;
  crimeInfo: crime_info_pb.CrimeInfoServiceClient;
  crime: crime_pb.CrimeServiceClient;
  buy: buy_pb.AugBuyServiceClient;
  install: install_pb.InstallServiceClient;
  homeRam: home_ram_pb.HomeRamServiceClient;
};

export function factionClients(ns: NS): FactionClients {
  return {
    catalog: catalog_pb.NewAugCatalogServiceClient(ns),
    detail: detail_pb.NewAugDetailServiceClient(ns),
    standing: standing_pb.NewStandingServiceClient(ns),
    invite: invite_pb.NewInviteServiceClient(ns),
    work: work_pb.NewWorkServiceClient(ns),
    job: job_pb.NewJobServiceClient(ns),
    crimeInfo: crime_info_pb.NewCrimeInfoServiceClient(ns),
    crime: crime_pb.NewCrimeServiceClient(ns),
    buy: buy_pb.NewAugBuyServiceClient(ns),
    install: install_pb.NewInstallServiceClient(ns),
    homeRam: home_ram_pb.NewHomeRamServiceClient(ns),
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
export type WorkRound = { invites: invite_pb.GetInvitesResponse; work: work_pb.GetWorkResponse };

export async function fetchWork(c: FactionClients, req: ViewRequest, deadline: Deadline): Promise<WorkRound | CallFailure> {
  const [invites, work] = await Promise.all([
    c.invite.GetInvites({ factions: req.requirementFactions }, deadline),
    c.work.GetWork({ factions: req.joined }, deadline),
  ]);
  const failed = failure("InviteService.GetInvites", invites) ?? failure("WorkService.GetWork", work);
  if (failed) return failed;
  return { invites: invites.data as invite_pb.GetInvitesResponse, work: work.data as work_pb.GetWorkResponse };
}

/**
 * The tick's view on top of the first round: standing and the catalog, then
 * the details of every listed and pending augmentation, with crime info.
 */
export async function fetchView(c: FactionClients, req: ViewRequest, first: WorkRound, deadline: Deadline): Promise<FactionView | CallFailure> {
  const [standing, catalogFirst] = await Promise.all([
    c.standing.GetStanding({ factions: req.joined, companies: req.companies }, deadline),
    c.catalog.GetCatalog({ factions: [...new Set([...req.joined, ...req.offerFactions])] }, deadline),
  ]);
  const failedFirst = failure("StandingService.GetStanding", standing) ?? failure("AugCatalogService.GetCatalog", catalogFirst);
  if (failedFirst) return failedFirst;
  const standingData = standing.data as standing_pb.GetStandingResponse;
  let catalog = catalogFirst.data as catalog_pb.GetCatalogResponse;
  // Pending augmentations no listed faction sells still need their stats and price.
  const listed = new Set((catalog.prices ?? []).map((p) => p.name));
  const installed = new Set(standingData.installed ?? []);
  const extra = (standingData.ownedWithQueued ?? []).filter((n) => !installed.has(n) && !listed.has(n));
  if (extra.length > 0) {
    const more = await c.catalog.GetCatalog({ factions: [], extraNames: extra }, deadline);
    const failedMore = failure("AugCatalogService.GetCatalog", more);
    if (failedMore) return failedMore;
    catalog = { offers: catalog.offers, prices: [...(catalog.prices ?? []), ...((more.data as catalog_pb.GetCatalogResponse).prices ?? [])] };
  }
  const names = (catalog.prices ?? []).map((p) => p.name ?? "");
  const [details, crimes] = await Promise.all([c.detail.GetDetails({ names }, deadline), c.crimeInfo.GetCrimes({}, deadline)]);
  const failedDetails = failure("AugDetailService.GetDetails", details);
  if (failedDetails) return failedDetails;
  return new FactionView({
    standing: standingData,
    catalog,
    details: details.data as detail_pb.GetDetailsResponse,
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
