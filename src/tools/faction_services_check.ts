import { NS } from "@ns";
import { Codes } from "system/rpc/status";
import { deadlineIn } from "system/deadline";
import { factionClients, succeeded } from "factions/faction_gateway";
import { GYM_CITY } from "factions/study_decisions";

/**
 * Live smoke test of the faction services (docs/faction_split.md): calls
 * every method once, in ways that are safe in a running game, and reports
 * each call's result and round trip:
 *
 *   run tools/faction_services_check.js [--out /var/claude_out/faction_services_check.txt]
 *
 * Work actions (faction work, travel, gym, crime) end with Stop - the
 * faction and study daemons put the player back on their own choice within
 * a tick. Spends a $1B donation and tries one NeuroFlux purchase; home RAM
 * upgrades are bought if affordable. Never joins a faction, quits a job or
 * installs (none of those can be undone).
 */
const GYM = "Powerhouse Gym";
const DONATION = 1e9;

export async function main(ns: NS): Promise<void> {
  const c = factionClients(ns);
  const lines: string[] = [];
  let failures = 0;
  const check = async <T extends { status: Codes; error?: string }>(label: string, call: () => Promise<T>, ok: (res: T) => boolean = (r) => r.status === Codes.OK, detail: (res: T) => string = () => ""): Promise<T> => {
    const start = Date.now();
    const res = await call();
    const passed = ok(res);
    if (!passed) failures++;
    lines.push(`${passed ? "ok  " : "FAIL"} ${label.padEnd(44)} ${String(Date.now() - start).padStart(4)} ms  ${res.status === Codes.OK ? detail(res) : `status ${res.status}: ${res.error ?? ""}`}`);
    return res;
  };
  const player = ns.getPlayer();
  const joined = player.factions;

  const info = await check("FactionInfoService.Snapshot", () => c.info.Snapshot({ standingFactions: joined, offerFactions: joined, companies: Object.keys(player.jobs) }, deadlineIn(5000)), undefined, (r) =>
    `${r.data?.augmentations?.length ?? 0} augmentations, ${r.data?.installed?.length ?? 0} installed, favor to donate ${r.data?.favorToDonate}`
  );
  const work = await check("FactionWorkService.Snapshot", () => c.work.Snapshot({ requirementFactions: ["Illuminati"], workTypeFactions: joined }, deadlineIn(5000)), undefined, (r) =>
    `${r.data?.invitations?.length ?? 0} invitations, current work ${r.data?.currentWorkJson?.slice(0, 60)}`
  );
  await check("CrimeService.Snapshot", () => c.crime.Snapshot({}, deadlineIn(5000)), (r) => r.status === Codes.OK && (r.data?.crimes?.length ?? 0) > 0, (r) => `${r.data?.crimes?.length} crimes`);
  await check("AugmentPurchaseService.Snapshot", () => c.purchase.Snapshot({}, deadlineIn(5000)), undefined, (r) => `home RAM cost ${r.data?.homeRamCost}, positions ${r.data?.positionsHeld}`);

  // Work actions, each undone by Stop at the end.
  const hackingFaction = (work.data?.workTypes ?? []).find((t) => (t.types ?? []).includes("hacking"))?.faction;
  if (hackingFaction) await check(`WorkForFaction(${hackingFaction}, hacking)`, () => c.work.WorkForFaction({ faction: hackingFaction, workType: "hacking" }, deadlineIn(5000)), succeeded);
  await check(`Travel(${player.city}) (where the player is)`, () => c.work.Travel({ city: player.city }, deadlineIn(5000)), (r) => r.status === Codes.OK);
  const gymCity = GYM_CITY[GYM];
  if (gymCity) await check(`Travel(${gymCity})`, () => c.work.Travel({ city: gymCity }, deadlineIn(5000)), succeeded);
  await check(`Gym(${GYM}, str)`, () => c.work.Gym({ location: GYM, gymType: "str" }, deadlineIn(5000)), succeeded);
  await check("Crime.Commit(Mug)", () => c.crime.Commit({ crime: "Mug" }, deadlineIn(5000)), succeeded);
  const job = Object.keys(player.jobs)[0];
  if (job) await check(`WorkForCompany(${job})`, () => c.work.WorkForCompany({ company: job }, deadlineIn(5000)), succeeded);
  await check("Stop", () => c.work.Stop({}, deadlineIn(5000)), (r) => r.status === Codes.OK);

  // Spending: a small donation, one NeuroFlux attempt, home RAM if affordable.
  const donatable = (info.data?.standings ?? []).find((s) => (s.favor ?? 0) >= (info.data?.favorToDonate ?? Infinity))?.faction;
  if (donatable) {
    await check(`Donate(${donatable}, $1B)`, () => c.purchase.Donate({ faction: donatable, amount: DONATION }, deadlineIn(5000)), succeeded);
    await check(`Purchase(${donatable}, NeuroFlux Governor)`, () => c.purchase.Purchase({ faction: donatable, augmentation: "NeuroFlux Governor" }, deadlineIn(5000)), (r) => r.status === Codes.OK, (r) =>
      r.data?.ok ? "bought" : "refused by the game (rep or cash) - the call itself worked"
    );
  }
  await check("UpgradeHomeRam", () => c.purchase.UpgradeHomeRam({}, deadlineIn(5000)), undefined, (r) => `${r.data?.costs?.length ?? 0} upgrade(s), RAM ${r.data?.ramAfter}`);

  lines.unshift(`faction services check: ${failures === 0 ? "all passed" : `${failures} FAILED`} (${new Date().toISOString()})`);
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), lines.join("\n"), "w");
  else ns.tprint(lines.join("\n"));
}
