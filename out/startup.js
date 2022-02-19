// @ts-ignore
import { servers } from "/automation/lib/scan.js";
// @ts-ignore
import { root } from "/automation/lib/root.js"

/**
 *  Startup all start-of-game automation.  Use "--verbose" argument if
 * you want info logs written to the console.
 * 
 *  Startup attempts to fill up the machine's memory with a ratio of
 *   grow/hack/weak for machine. If using this script, always upgrade
 *   server size when able.
 * 
 *  @param {import("../.").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["verbose", false],
        ["log_listener", false],
    ]);
    if (flags.log_listener) {
        if (!ns.isRunning('/automation/util/log-listener.js', 'home')) {
            ns.exec('/automation/util/log-listener.js', 'home', 1);
        }
    }

    const exclude = ["home", "darkweb"]
    let print = ns.print;
    if (flags.verbose) {
        print = ns.tprint
    }
    
    while (true) {
        const all = servers(ns, true);
        const h = all.filter(function (server) {
            return !(
                (exclude.includes(server)) ||
                (ns.getServerRequiredHackingLevel(server) > ns.getHackingLevel()) ||
                ns.isRunning("/automation/util/weaken.js", "home", server))
        });

        for (const server of h) {
            const s = ns.getServer(server)
            if (!s.hasAdminRights) {
                print(`INFO: getting root on ${server}...`)
                if (!root(ns, server, flags.verbose)) {
                    continue;
                }
            }
            if (ns.getServerMaxMoney(server) == 0) {
                print(`INFO: not starting hack script for ${server}, there's no money in it.`)
                continue;
            }
            print(`INFO: starting hack script for ${server}...`);
            try {
                ns.exec("/automation/util/start-hack.js", "home", 1, "--server", "home", "--target", server);
            }
            catch (error) {
                print(error)
            }
        }
        // Try again in a minute.
        await ns.sleep(60000)
    }
}

export function autocomplete(data, args) {
    data.flags([
        ["verbose", false],
    ])
    return []
}