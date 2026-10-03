import { NS } from "@ns";
import { readNetwork } from "development/libraries/network";

/**
 * One-shot: cross-references every known server's `organization` (already
 * crawled live by crawl_servers.ts - no ns.getServer call needed here)
 * against ns.stock.getOrganization(sym) for every live stock symbol, to
 * answer "which of our currently-known servers are actually stock-linked."
 * Confirmed via Bitburner's own source (StockMarket/PlayerInfluencing.ts):
 * only hack()/grow() (not weaken()) on a server whose organization matches
 * a real stock can ever nudge that stock's forecast, and only when the
 * call passes {stock: true} - most NPC servers (n00dles, foodnstuff, etc.)
 * have no stock at all, so this answers whether pursuing that mechanic is
 * even worth it given our currently-reachable network.
 */
export async function main(ns: NS): Promise<void> {
  const lines: string[] = [];

  if (!ns.stock.hasTixApiAccess()) {
    ns.tprint("[StockServerReport] No TIX API access yet - buy it first (ns.stock calls throw without it).");
    return;
  }
  const symbols = ns.stock.getSymbols();
  const orgToSymbol = new Map<string, string>();
  for (const sym of symbols) orgToSymbol.set(ns.stock.getOrganization(sym), sym);

  const servers = readNetwork(ns, Infinity)?.servers ?? [];

  const linked = servers
    .filter((s) => s.organization && orgToSymbol.has(s.organization))
    .map((s) => ({ server: s, sym: orgToSymbol.get(s.organization) as string }));

  const has4S = ns.stock.has4SDataTixApi();

  lines.push(`=== Stock-linked servers (${linked.length} of ${servers.length} known) ===`);
  if (linked.length === 0) {
    lines.push("None of our currently-crawled servers are stock-linked.");
  }
  for (const { server, sym } of linked) {
    const forecast = has4S ? ns.stock.getForecast(sym).toFixed(2) : "n/a (no 4S data yet)";
    lines.push(
      `${server.host} -> ${sym} (${server.organization}) | forecast=${forecast} price=$${ns.stock.getPrice(sym).toFixed(2)} ` +
        `rooted=${server.rooted} maxMoney=$${server.maxMoney.toFixed(0)}`
    );
  }

  lines.push("");
  lines.push(`=== Every live stock symbol's organization (${symbols.length} total) ===`);
  for (const sym of symbols) {
    const org = ns.stock.getOrganization(sym);
    const known = servers.some((s) => s.organization === org);
    lines.push(`${sym}: "${org}"${known ? " (server known)" : " (server not yet crawled/reachable)"}`);
  }

  ns.tprint(lines.join("\n"));
}
