// @ts-ignore
import { safeRoot } from "/automation/lib/root.js"
// @ts-ignore
import { scan, path } from "/automation/lib/scan.js"
// @ts-ignore
import { run } from "/automation/lib/terminal.js"

/** 
 * Attempts to backdoor all avilable servers.
 *    NOTE: currently the timing interval is WAY off.
 * 
 * 
 * @param {import("../../..").NS } ns */
export async function main(ns) {
    const purchased = ns.getPurchasedServers()
    let eligible = scan(ns).filter(function (name) {
        const server = ns.getServer(name);
        return !server.backdoorInstalled && server.requiredHackingSkill <= ns.getHackingLevel() && server.hostname != 'home' && !purchased.includes(name)
    })
    eligible.sort((left, right) => { //sort by easiest to hardest
        const l = ns.getServer(left).requiredHackingSkill
        const r = ns.getServer(right).requiredHackingSkill
        if (l > r) return 1
        if (l < r) return -1
        return 0;
    })
    let source = ns.getHostname()
    await ns.tprintf("INFO: %s", eligible)
    while (eligible.length != 0) {
        let dest = eligible.shift()
        await ns.tprintf("INFO: Connecitng to %s", dest)
        await safeRoot(ns, dest)
        const hops = await path(ns, source, dest)
        let command = "connect " + hops.join("; connect ") + "; backdoor";
        await run(command);
        const serverLevel = await ns.getServer(dest).requiredHackingSkill
        // If you have formul
        // await ns.formulas.hacking.hackTime(dest,ns.getPlayer());
        if (serverLevel > 600) {
            await ns.sleep(300000);
        } else if (serverLevel > 500) {
            await ns.sleep(180000);
        } else if (serverLevel > 400) {
            await ns.sleep(60000)
        } else if (serverLevel > 150) {
            await ns.sleep(30000)
        } else {
            await ns.sleep(10000);
        }
        source = dest;
    }
}