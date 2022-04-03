// @ts-ignore
import { servers } from "/automation/lib/scan.js";
/**  install-scripts-all.js installs the main hacking scripts on all servers to which we have root.
 * @param {import("../../..").NS } ns */
 export async function main(ns) {
    for (let s of servers(ns, true)) {
        if (s == "home" || !ns.hasRootAccess(s)) {
            continue
        }
        await ns.scp([
            "/automation/util/weaken.js",
            "/automation/util/grow.js",
            "/automation/util/hack.js",
            "/automation/lib/log.js",
        ], "home", s)
        ns.tprintf(`INFO: installed scripts on ${s}.`)
    }
 }