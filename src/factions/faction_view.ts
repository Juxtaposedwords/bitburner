import type { PlayerRequirement } from "@ns";
import { AugmentationInfo, pendingAugmentations } from "factions/faction_decisions";
import * as fs_pb from "factions/rpc/faction_services";

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

export class FactionView {
  private readonly offers = new Map<string, string[]>();
  private readonly augs = new Map<string, fs_pb.Augmentation>();
  private readonly standing = new Map<string, fs_pb.Standing>();
  private readonly companies = new Map<string, number>();
  private readonly requirements = new Map<string, PlayerRequirement[]>();
  private readonly types = new Map<string, string[]>();
  private readonly crimeInfo = new Map<string, fs_pb.CrimeInfo>();
  readonly ownedWithQueued: string[];
  readonly installed: string[];
  readonly favorToDonate: number;
  readonly invitations: string[];
  readonly currentWork: CurrentWork;

  constructor(info: fs_pb.InfoSnapshot, work: fs_pb.WorkSnapshot, crimes?: fs_pb.CrimeSnapshot) {
    for (const o of info.offers ?? []) this.offers.set(o.faction ?? "", o.augmentations ?? []);
    for (const a of info.augmentations ?? []) this.augs.set(a.name ?? "", a);
    for (const s of info.standings ?? []) this.standing.set(s.faction ?? "", s);
    for (const c of info.companyStandings ?? []) this.companies.set(c.company ?? "", c.rep ?? 0);
    for (const r of work.requirements ?? []) this.requirements.set(r.faction ?? "", JSON.parse(r.requirementsJson || "[]") as PlayerRequirement[]);
    for (const t of work.workTypes ?? []) this.types.set(t.faction ?? "", t.types ?? []);
    for (const c of crimes?.crimes ?? []) this.crimeInfo.set(c.crime ?? "", c);
    this.ownedWithQueued = info.ownedWithQueued ?? [];
    this.installed = info.installed ?? [];
    this.favorToDonate = info.favorToDonate ?? Infinity;
    this.invitations = work.invitations ?? [];
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
        catalog.push({ name, faction, price: aug.price ?? Infinity, repReq: aug.repReq ?? Infinity, prereqs: aug.prereqs ?? [], stats: this.statsOf(name) });
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
  crimes(): fs_pb.CrimeInfo[] {
    return [...this.crimeInfo.values()];
  }

  crimeOf(crime: string): fs_pb.CrimeInfo | undefined {
    return this.crimeInfo.get(crime);
  }
}
