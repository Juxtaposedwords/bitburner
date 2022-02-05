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
        safeRoot(ns, name)
        return !server.backdoorInstalled &&
            server.requiredHackingSkill <= ns.getHackingLevel() &&
            server.hostname != 'home' && !purchased.includes(name) &&
            server.hasAdminRights
    })
    const valueTargets = ["avmnite-02h", "CSEC", "run4theh111z", "I.I.I.I"]
    eligible.sort((left, right) => { //sort by easiest to hardest
        const l = ns.getServer(left).requiredHackingSkill
        const r = ns.getServer(right).requiredHackingSkill
        if (l > r) return 1
        if (l < r) return -1
        return 0;
    })
    eligible.sort((left, right) => { //sort by notable targets (such as hacking functions)
        if (valueTargets.includes(left) && valueTargets.includes(right)) { return 0 }
        if (valueTargets.includes(left)) { return 1 }
        if (valueTargets.includes(right)) { return -1 }
    })
    let source = ns.getHostname()
    await ns.tprintf("INFO: %s", eligible)
    while (eligible.length != 0) {
        let dest = eligible.shift()
        await ns.tprintf("INFO: Connecting to %s", dest)
        await safeRoot(ns, dest)
        const hops = await path(ns, source, dest)
        let command = "connect " + hops.join("; connect ") + "; backdoor";
        await run(command);
        const serverLevel = await ns.getServer(dest).requiredHackingSkill
        await ns.sleep(ns.formulas.hacking.hackTime(dest, ns.getPlayer()));
        source = dest;
    }
}