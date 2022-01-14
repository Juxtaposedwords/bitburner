// @ts-ignore
import { safeRoot } from "/automation/lib/root.js";
// @ts-ignore
import { servers } from "/automation/lib/scan.js";
/**
 *  Quick and easy way to point your fleet at one target with:
 *   ghw-setup <target>
 * 
 *  If no target is provided, the scripts run against the machine where they're located
 * 
 * 
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    var target = ns.args[0]

    let eligible = servers(ns).filter(function (name) {
        const server = ns.getServer(name);
        return (server.requiredHackingSkill <= ns.getHackingLevel() || server.hasAdminRights)
    })
    ns.tprintf("Starting for %d servers", eligible.length)
    let ghw = "/automation/util/grow-hack-weak.js";
    let logger = "/automation/util/log-listener.js";
    let files = [
        "/automation/util/grow-hack-weak.js",
        "/automation/util/grow.js",
        "/automation/util/hack.js",
        ghw,
        logger,
        ...ns.ls("home").filter(input => { return String(input).startsWith("/automation/lib/") }), // all of our libraries
    ];

    for (const server of eligible) {
        ns.tprintf("starting for %s", server)
        // Just to make sure we have root
        safeRoot(ns, server)

        var offset = 0
        if (server == "home") {
            // Depending on who you are you'll want to run some beefy command at home
            offset = 500
        }
        // Stop any existing scripts. This way we can support updates.
        if (server != "home") {
            ns.killall(server)
            for (const script of files) {
                await ns.scp(script, "home", server)
            }
        }
        if (target == undefined) {
            target = server
        } else if (target == undefined && (!ns.getPurchasedServers().includes(server) || server == "home")) {
            ns.tprintf("WARN: unable to start script on %s as no target was provided and the machine as purchased cannot hack itself", server)
            continue
        }
        if (server != "home") {
            for (const script of files) {
                await ns.scp(script, "home", server)
            }
        }

        // start server logger
        await ns.exec(logger, server)


        var availRam = ns.getServer(server).maxRam - (ns.getServer(server).ramUsed + offset);
        var progRam = ns.getScriptRam(ghw, server);
        var memCount = (availRam / progRam)
        if (memCount < 1) {
            continue
        }
        ns.exec(ghw, server, memCount, target);

    }
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}
