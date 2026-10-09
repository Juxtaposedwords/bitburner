import type { PlayerRequirement } from "@ns";
import { AugmentationInfo, pendingAugmentations } from "factions/faction_decisions";
import * as types_pb from "factions/rpc/faction_types";
import * as standing_pb from "factions/rpc/standing";
import * as catalog_pb from "factions/rpc/aug_catalog";
import * as detail_pb from "factions/rpc/aug_detail";
import * as invite_pb from "factions/rpc/invite";
import * as work_pb from "factions/rpc/work";
import * as crime_info_pb from "factions/rpc/crime_info";

/**
 * The game as the faction daemon sees it for one tick: the snapshots its
 * services returned (faction_services.proto), read synchronously by the
 * decision code. Pure - no ns - so it costs no RAM and tests directly.
 *
 * Method names stay clear of the game's function names: the game charges
 * RAM for any identifier matching one, whatever object it belongs to.
 */
export type CurrentWork = {
  type?: string;
  factionName?: string;
  factionWorkType?: string;
  companyName?: string;
  location?: string;
  classType?: string;
  crimeType?: string;
} | null;

/** One tick's snapshots, from the faction services (faction_services.proto). */
export type FactionSnapshots = {
  standing: standing_pb.GetStandingResponse;
  catalog: catalog_pb.GetCatalogResponse;
  details: detail_pb.GetDetailsResponse;
  invites: invite_pb.GetInvitesResponse;
  work: work_pb.GetWorkResponse;
  // Absent without the crime info service: crime decisions wait then.
  crimes?: crime_info_pb.GetCrimesResponse;
};

type AugEntry = { price: number; repReq: number; prereqs: string[]; stats: types_pb.Stat[] };

export class FactionView {
  private readonly offers = new Map<string, string[]>();
  private readonly augs = new Map<string, AugEntry>();
  private readonly standing = new Map<string, types_pb.Standing>();
  private readonly companies = new Map<string, number>();
  private readonly requirements = new Map<string, PlayerRequirement[]>();
  private readonly types = new Map<string, string[]>();
  private readonly crimeInfo = new Map<string, types_pb.CrimeInfo>();
  readonly ownedWithQueued: string[];
  readonly installed: string[];
  readonly favorToDonate: number;
  readonly invitations: string[];
  readonly currentWork: CurrentWork;

  constructor(snaps: FactionSnapshots) {
    const { standing, catalog, details, invites, work, crimes } = snaps;
    for (const o of catalog.offers ?? []) this.offers.set(o.faction ?? "", o.augmentations ?? []);
    const detailOf = new Map((details.details ?? []).map((d) => [d.name ?? "", d]));
    for (const p of catalog.prices ?? []) {
      const d = detailOf.get(p.name ?? "");
      this.augs.set(p.name ?? "", { price: p.price ?? Infinity, repReq: p.repReq ?? Infinity, prereqs: d?.prereqs ?? [], stats: d?.stats ?? [] });
    }
    for (const s of standing.standings ?? []) this.standing.set(s.faction ?? "", s);
    for (const c of standing.companyStandings ?? []) this.companies.set(c.company ?? "", c.rep ?? 0);
    for (const r of invites.requirements ?? []) this.requirements.set(r.faction ?? "", JSON.parse(r.requirementsJson || "[]") as PlayerRequirement[]);
    for (const t of work.workTypes ?? []) this.types.set(t.faction ?? "", t.types ?? []);
    for (const c of crimes?.crimes ?? []) this.crimeInfo.set(c.crime ?? "", c);
    this.ownedWithQueued = standing.ownedWithQueued ?? [];
    this.installed = standing.installed ?? [];
    this.favorToDonate = standing.favorToDonate ?? Infinity;
    this.invitations = invites.invitations ?? [];
    this.currentWork = JSON.parse(work.currentWorkJson || "null") as CurrentWork;
  }

  /** What `faction` sells ([] if it wasn't asked about). */
  offered(faction: string): string[] {
    return this.offers.get(faction) ?? [];
  }

  /** `name`'s multipliers, as getAugmentationStats gives them. */
  statsOf(name: string): Record<string, number> {
    return Object.fromEntries((this.augs.get(name)?.stats ?? []).map((s) => [s.key ?? "", s.value ?? 0]));
  }

  /** Every augmentation `factions` sell, with price, rep requirement, prerequisites and stats. */
  catalogFor(factions: string[]): AugmentationInfo[] {
    const catalog: AugmentationInfo[] = [];
    for (const faction of factions) {
      for (const name of this.offered(faction)) {
        const aug = this.augs.get(name);
        if (!aug) continue;
        catalog.push({ name, faction, price: aug.price, repReq: aug.repReq, prereqs: aug.prereqs, stats: this.statsOf(name) });
      }
    }
    return catalog;
  }

  repOf(faction: string): number {
    return this.standing.get(faction)?.rep ?? 0;
  }

  favorOf(faction: string): number {
    return this.standing.get(faction)?.favor ?? 0;
  }

  /** Rep for each of `factions`. */
  repsFor(factions: string[]): Record<string, number> {
    return Object.fromEntries(factions.map((f) => [f, this.repOf(f)]));
  }

  /** Bought but not installed yet. */
  pending(): string[] {
    return pendingAugmentations(this.ownedWithQueued, this.installed);
  }

  companyRepOf(company: string): number {
    return this.companies.get(company) ?? 0;
  }

  /** getFactionInviteRequirements for `faction` ([] if it wasn't asked about). */
  requirementsOf(faction: string): PlayerRequirement[] {
    return this.requirements.get(faction) ?? [];
  }

  workTypesOf(faction: string): string[] {
    return this.types.get(faction) ?? [];
  }

  /** Every crime's stats and chance (empty without a crime snapshot). */
  crimes(): types_pb.CrimeInfo[] {
    return [...this.crimeInfo.values()];
  }

  crimeOf(crime: string): types_pb.CrimeInfo | undefined {
    return this.crimeInfo.get(crime);
  }
}
