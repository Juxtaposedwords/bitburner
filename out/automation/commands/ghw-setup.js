// @ts-ignore
import { safeRoot } from "/automation/lib/root.js";
// @ts-ignore
import { allServers } from "/automation/lib/scan.js";
/**
 *  Quick and easy way to point your fleet at one target with:
 *   ghw-setup --target=<target>
 * 
 *  If no target is provided, the scripts run against the machine where they're located
 * 
 * 
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["target", ""],           // Server to target
        ["force_restart", false], // determines whether ot use pretty format or not
        ["level",false]
    ])
    let target = String(flags.target)
    if (target != "" && !ns.serverExists(target)) {
        ns.tprintf("ERROR: %s is not a valid target. Consider using the autocomplete with the --target flag", target)
        return
    }

    let eligible = allServers(ns).filter( (name) => {
        const server = ns.getServer(name);
        safeRoot(name);
        return (server.requiredHackingSkill <= ns.getHackingLevel() || server.hasAdminRights)
    })
    ns.tprintf("Starting for %d servers", eligible.length)
    let ghw = "/automation/util/grow-hack-weak.js";
    let files = [
        ghw,
        "/automation/util/grow.js",
        "/automation/util/hack.js",
        "/automation/util/weaken.js",
        ...ns.ls("home").filter(input => { return String(input).startsWith("/automation/lib/") }), // all of our libraries
    ];

    for (const server of eligible) {
        if (server == "home") {
          continue
        }
        // Just to make sure we have root
        safeRoot(ns, server)
        if (flags.target == undefined) {
            target = server
        } else if (flags.target == undefined && (!ns.getPurchasedServers().includes(server) || server == "home")) {
            ns.tprintf("WARN: unable to start script on %s as no target was provided and the machine as purchased cannot hack itself", server)
            continue
        }

        for (const script of files) {
            await ns.scp(script, "home", server)
        }

        await killGHW(ns, server, ghw, target, flags.force_restart)
        for (const script of files) {
            await ns.scp(script, "home", server)
        }

        var availRam = ns.getServer(server).maxRam - (ns.getServer(server).ramUsed);
        var progRam = ns.getScriptRam(ghw, server);
        var memCount = (availRam / progRam)
        if (memCount < 1) {
            continue
        }
        let args = [target]
        if (flags.level) {
            args.push("level")
        }
        ns.exec(ghw, server, memCount, ...args);

    }
}

export function autocomplete(data, args) {
    data.flags([
        ["target", ""], 
        ["force_restart", false],
        ["level",false],
    ])
    const options = {
        'target': [...data.servers],
    }
    for (let arg of args.slice(-2)) {
        if (arg.startsWith('--')) {
            return options[arg.slice(2)] || []
        }
    }
    return []
}

/** 
 *  Critiea for killing porcesese on the target server :
 *   1. Matches the filename provided
 *   2. One of:
 *      * Force was selected  
 *      * The target in use by the grow-hack-weak does not match the one you provide
 *  @param {import("../../..").NS } ns */
async function killGHW(ns, server, filename, target, force) {
    const processes = ns.ps(server).filter((process) => {
        return (filename == process.filename)
    })
    for (const process of processes) {
        if (
            force ||
            (process.args[0] != undefined && target != process.args[0])) {
            await ns.kill(process.pid)
        }
    }

}