import { NS } from "@ns";
import * as pb from "factions/rpc/invite";

type FactionNameType = Parameters<NS["singularity"]["joinFaction"]>[0];

/** InviteService: invitations, what each faction's invite needs, and joining. */
export function createInviteHandlers(ns: NS): pb.InviteServiceHandlers {
  return {
    GetInvites: (req) => ({
      invitations: ns.singularity.checkFactionInvitations(),
      requirements: (req.factions ?? []).map((faction) => ({
        faction,
        requirementsJson: JSON.stringify(ns.singularity.getFactionInviteRequirements(faction as FactionNameType)),
      })),
    }),
    Join: (req) => ({ ok: ns.singularity.joinFaction(req.faction as FactionNameType) }),
  };
}
