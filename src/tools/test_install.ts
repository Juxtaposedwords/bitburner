import { NS } from "@ns";
import { Codes } from "system/rpc/status";
import { deadlineIn } from "system/deadline";
import { factionClients, succeeded } from "factions/faction_gateway";

/**
 * Tests the install path through the faction services, live:
 *
 *   run tools/test_install.js [--out /var/claude_out/install_test.txt]
 *
 * Buys one NeuroFlux Governor through AugmentPurchaseService at a faction
 * taking donations (donating the rep it lacks), sells every stock position
 * (an install deletes them with no refund), then installs through the same
 * service. Afterwards boot.js must bring the services and the faction
 * daemon back. Writes what it did before installing.
 */
const NFG = "NeuroFlux Governor";

export async function main(ns: NS): Promise<void> {
  const out = ns.args.indexOf("--out") >= 0 ? String(ns.args[ns.args.indexOf("--out") + 1]) : undefined;
  const lines: string[] = [`install test started ${new Date().toISOString()}`];
  const report = (line: string): void => {
    lines.push(line);
    if (out) ns.write(out, lines.join("\n"), "w");
    else ns.tprint(line);
  };
  const c = factionClients(ns);
  const player = ns.getPlayer();
  const info = await c.info.Snapshot({ standingFactions: player.factions, offerFactions: player.factions, companies: [] }, deadlineIn(5000));
  if (info.status !== Codes.OK || !info.data) return report(`FAIL: FactionInfoService.Snapshot status ${info.status}: ${info.error}`);
  const nfg = info.data.augmentations?.find((a) => a.name === NFG);
  const offering = new Set((info.data.offers ?? []).filter((o) => (o.augmentations ?? []).includes(NFG)).map((o) => o.faction));
  const faction = (info.data.standings ?? []).find((s) => offering.has(s.faction) && (s.favor ?? 0) >= (info.data?.favorToDonate ?? Infinity));
  if (!nfg || !faction?.faction) return report("FAIL: no faction taking donations sells NeuroFlux.");

  const gap = (nfg.repReq ?? 0) - (faction.rep ?? 0);
  if (gap > 0) {
    const amount = Math.ceil(ns.formulas.reputation.donationForRep(gap, player) * 1.01);
    const donated = await c.purchase.Donate({ faction: faction.faction, amount }, deadlineIn(5000));
    report(`${succeeded(donated) ? "ok  " : "FAIL"} donated $${(amount / 1e9).toFixed(1)}B to ${faction.faction} for ${gap.toFixed(0)} rep`);
  }
  const bought = await c.purchase.Purchase({ faction: faction.faction, augmentation: NFG }, deadlineIn(5000));
  report(`${succeeded(bought) ? "ok  " : "FAIL"} bought ${NFG} from ${faction.faction} ($${((nfg.price ?? 0) / 1e9).toFixed(1)}B)`);
  if (!succeeded(bought)) return;

  let sold = 0;
  if (ns.stock.hasTixApiAccess()) {
    for (const sym of ns.stock.getSymbols()) {
      const [long, , short] = ns.stock.getPosition(sym);
      if (long > 0 && ns.stock.sellStock(sym, long) > 0) sold++;
      if (short > 0 && ns.stock.sellShort(sym, short) > 0) sold++;
    }
  }
  report(`ok   sold ${sold} stock position(s)`);
  report(`installing through AugmentPurchaseService at ${new Date().toISOString()} - boot.js runs next`);
  await c.purchase.Install({ bootScript: "boot.js" }, deadlineIn(5000));
  report("FAIL: still running after Install - the install didn't happen.");
}
