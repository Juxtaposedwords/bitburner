import { NS } from "@ns";
import * as fs_pb from "factions/rpc/faction_services";

type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];

/** InviteService: invitations, what each faction's invite needs, and joining. */
export function createInviteHandlers(ns: NS): fs_pb.InviteServiceHandlers {
  return {
    Snapshot: (req) => ({
      invitations: ns.singularity.checkFactionInvitations(),
      requirements: (req.factions ?? []).map((faction) => ({
        faction,
        requirementsJson: JSON.stringify(ns.singularity.getFactionInviteRequirements(faction as FactionNameType)),
      })),
    }),
    Join: (req) => ({ ok: ns.singularity.joinFaction(req.faction as FactionNameType), detail: "" }),
  };
}
