/** @param {NS} ns **/

import { servers } from "/automation/lib/scan.js";
import { root } from "/automation/lib/root.js"

// Startup all start-of-game automation.  Use "verbose" argument if
// you want info logs written to the console.
export async function main(ns) {
    const verbose = (ns.args.length > 0 && ns.args[0] == "verbose");

    if (!ns.isRunning('/automation/util/log-listener.js', 'home')) {
        ns.exec('/automation/util/log-listener.js', 'home', 1);
    }

    while (true) {
        const all = servers(ns, true);
        const h = [];
        for (const s of all) {
            if (s == "home" || s == "darkweb") {
                continue;
            }
            if (ns.getServerRequiredHackingLevel(s) > ns.getHackingLevel()) {
                continue;
            }
            if (ns.isRunning("/automation/util/weaken.js", "home", s)) {
                continue;
            }
            h.push(s);
        }
        for (const s of h) {
            if (verbose) {
                ns.tprint(`INFO: getting root on ${s}...`)
            };
            if (!root(ns, s, false, verbose)) {
                continue;
            }
            if (ns.getServerMaxMoney(s) == 0) {
                if (verbose) {
                    ns.tprint(`INFO: not starting hack script for ${s}, there's no money in it.`)
                }
                continue;
            }
            // This is only printed once per server, so display it even in non-verbose mode.
            ns.tprint(`INFO: starting hack script for ${s}...`);
            ns.exec("/automation/util/start-hack.js", "home", 1, "home", s);
        }
        // Try again in a minute.
        await ns.sleep(60000)
    }
}