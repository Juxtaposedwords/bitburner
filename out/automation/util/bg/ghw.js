// @ts-ignore
import { toolCount } from "/automation/lib/cracks.js"



/** 
 * ghw uses the world's worst batch script and determines based on hack level and 
 * tools which target should be used.
 * @param {import("../../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["level", false]
    ])
    while (true) {
        const script = "/automation/commands/ghw-setup.js"
        let target = ""
        if (toolCount(ns) < 3) {
            target = "joesguns"
        } else if (toolCount(ns) == 3 && ns.getHackingLevel() < 503) {
            target = "silver-helix"
        } else {
            target = "rho-construction"
        }
        let args = ["--target", target]
        if (ns.getHackingLevel()>2000) {
            args.push("--level")
        }
        ns.exec(script, ns.getHostname(), 1, ...args)
        await ns.sleep(1000 * 60 * 5)
    }
}
export function autocomplete(data, args) {
    data.flags([
        ["level", false],
    ])
    return []
}