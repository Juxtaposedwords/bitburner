// @ts-ignore
import { root } from  "/automation/lib/root.js"
// @ts-ignore
import { scan } from "/automation/lib/scan.js"

/** @param {import("../../..").NS } ns */
export async function main(ns) {
    for (const server of scan(ns).filter(server =>{
        const serverStats = ns.getServer(server)
        return (!serverStats.hasAdminRights && ns.getHackingLevel() >= serverStats.hackDifficulty) 
    })){
        root(ns, server,true)
    }
}