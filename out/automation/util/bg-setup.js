import { servers } from "/automation/lib/scan.js";
/**
 *  @param {import("../../..").NS } ns */

export async function main(ns) {
    var target = ns.args[0] + ""

    // add flag for:
    //      * restart
    let hackedServers = servers(ns).filter(function (server) {
        return (ns.hasRootAccess(server) && server != "home")
    })
    ns.tprintf("starting for %d servers",hackedServers.length)

    for (let server of hackedServers) {
        // Stop any existing scripts. This way we can support updates.
        ns.killall(server)
        if (target == undefined) {
            target = server
        }
        const fileName = "/automation/util/bg.js";
        await ns.scp(fileName, "home", server)
        var maxRam = ns.getServerMaxRam(server);
        var progRam = ns.getScriptRam(fileName, server);
        var memCount = (maxRam / progRam)
        if (memCount <1) {
            continue
        }
        ns.exec(fileName, server, memCount, target);
    }
}