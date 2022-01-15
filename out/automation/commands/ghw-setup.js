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
    const data = ns.flags([
        ["target", ""], // Which server ot target
        ["force_restart", false], // determines whether ot use pretty format or not
    ])
    let target = String(data["target"])
    if (target != "" && !ns.serverExists(target)){
        ns.tprintf("ERROR: %s is not a valid server target. consider using --target with autocomplete.")
        return
    }

    let eligible = servers(ns).filter(function (name) {
        const server = ns.getServer(name);
        return (server.requiredHackingSkill <= ns.getHackingLevel() || server.hasAdminRights)
    })
    ns.tprintf("Starting for %d servers", eligible.length)
    let ghw = "/automation/util/grow-hack-weak.js";
    let files = [
        "/automation/util/grow-hack-weak.js",
        "/automation/util/grow.js",
        "/automation/util/hack.js",
        "/automation/util/weaken.js",
        ghw,
        ...ns.ls("home").filter(input => { return String(input).startsWith("/automation/lib/") }), // all of our libraries
    ];

    for (const server of eligible) {
        ns.tprintf("INFO: starting for %s", server)
        // Just to make sure we have root
        safeRoot(ns, server)
        if (data["target"] == undefined) {
            target = server
        } else if (data["target"] == undefined && (!ns.getPurchasedServers().includes(server) || server == "home")) {
            ns.tprintf("WARN: unable to start script on %s as no target was provided and the machine as purchased cannot hack itself", server)
            continue
        }

        var offset = 0
        if (server == "home") {
            // Depending on who you are you'll want to run some beefy commands at home.
            offset = 500
        } else {
            // copy to non root servers
            for (const script of files) {
                await ns.scp(script, "home", server)
            }
        }
        await killGHW(ns, server, ghw, target, data["force_restart"])

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
    data.flags([
        ["target", ""], // Which server ot target
        ["force_restart", false], // determines whether ot use pretty format or not
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
 *  Kills every matching GWH
 * 
 *  @param {import("../../..").NS } ns */
async function killGHW(ns, server, filename, target, force) {
    const processes = ns.ps(server).filter((process) => {
        return (filename == process.filename)
    })
    for (const process of processes) {
        ns.tprint(process)

        if (
            force ||
            (process.args[0] != undefined && target != process.args[0])) {
            await ns.kill(process.pid)
        }
    }

}
