// @ts-ignore
import { safeRoot } from "/automation/lib/root.js"
// @ts-ignore
import { scan, path } from "/automation/lib/scan.js"
// @ts-ignore
import { run } from "/automation/lib/terminal.js"

/** 
 * Attempts to backdoor all avilable servers.
 * 
 * @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["no_formulas", false],
    ])
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
        if (valueTargets.includes(left)) { return -1 }
        if (valueTargets.includes(right)) { return 1 }
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

        const wait_time = ns.getHackTime(dest);
        ns.tprintf(`INFO: ${wait_time} `)
        if (!flags.no_formulas) {
            await ns.sleep(wait_time / 4 + (1000 * 2));

        } else {
            if (serverLevel > 600) {
                await ns.sleep(100000);
            } else if (serverLevel > 500) {
                await ns.sleep(150000);
            } else if (serverLevel > 400) {
                await ns.sleep(70000)
            } else if (serverLevel > 150) {
                await ns.sleep(30000)
            } else {
                await ns.sleep(10000);
            }
        }
        source = dest;
    }
    await run("home;");

}

export function autocomplete(data, args) {
    data.flags([
        ["no_formulas", false],
    ])
    return []
}