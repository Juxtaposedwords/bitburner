/** @param {NS} ns **/

import { servers } from "/automation/lib/scan.js";
import { root } from "/automation/lib/root.js"

// Startup all start-of-game automation.  Use "--verbose" argument if
// you want info logs written to the console.
export async function main(ns) {
    const data = ns.flags([
        ["verbose", false],
    ]);
    const verbose = data["verbose"];

    if (!ns.isRunning('/automation/util/log-listener.js', 'home')) {
        ns.exec('/automation/util/log-listener.js', 'home', 1);
    }

    const exclude = ["home", "darkweb"]
    const log = (message) => {
        if (verbose) {
            ns.tprint(message)
        }
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
            if (verbose) {
                log(`INFO: getting root on ${server}...`)
            };
            if (!root(ns, server, verbose)) {
                continue;
            }
            if (ns.getServerMaxMoney(server) == 0) {
                if (verbose) {
                    log(`INFO: not starting hack script for ${server}, there's no money in it.`)
                }
                continue;
            }
            // This is only printed once per server, so display it even in non-verbose mode.
            ns.tprint(`INFO: starting hack script for ${server}...`);
            ns.exec("/automation/util/start-hack.js", "home", 1, "home", server);
        }
        // Try again in a minute.
        await ns.sleep(60000)
    }
}