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
        ns.tprintf("starting: %s",server)
        // Stop any existing scripts. This way we can support updates.
        ns.killall(server)
        if (target == undefined) {
            target = server
        }
        await ns.scp("bg.js", "home", server)
        var maxRam = ns.getServerMaxRam(server);
        var progRam = ns.getScriptRam("bg.js", server);
        var memCount = (maxRam / progRam)
        if (memCount <1) {
            continue
        }
        ns.exec("bg.js", server, memCount, target);
    }
}