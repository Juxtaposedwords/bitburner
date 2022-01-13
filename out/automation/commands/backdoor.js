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
    let eligible = scan(ns).filter(function (name) {
        const server = ns.getServer(name);
        return !server.backdoorInstalled && server.requiredHackingSkill <= ns.getHackingLevel() && server.hostname != 'home' && !ns.getPurchasedServers().includes(name)
    })
    eligible.sort(function cmp(left, right) { //sort by easiest to hardest
        return ns.getServer(left).requiredHackingSkill > ns.getServer(right).requiredHackingSkill
    })
    let source = ns.getHostname()
    await ns.tprintf("INFO: %s", eligible)
    while (eligible.length != 0) {
        let dest = eligible.shift()
        await ns.tprintf("INFO: Connecitng to %s", dest)
        await safeRoot(ns, dest)
        const hops = await path(ns,source, dest)
        let command = "connect " + hops.join("; connect ") + "; backdoor";
        await run(command);
        const serverLevel = await ns.getServer(dest).requiredHackingSkill
        // TODO(juxtaposedwords): Add a formula to use #mafhs to do a better guess.
        if (serverLevel > 600) {
            await ns.sleep(400000);
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