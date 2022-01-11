/** @param {import("../../..").NS } ns */

import { log } from  "./automation/lib/log.js"

// weaken continuously weakens the target server.
export async function main(ns) {
    if (ns.args.length != 1) {
        ns.tprintf("ERROR: Usage: run weaken.js <target>.  Received %d arguments not 1.", ns.args.length);
        return;
    }
    const target = ns.args[0]
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: Need root access on ${target}.`);
        return;
    }
    await log(ns, 'weaken:start', target, 0);
 
    // Infinite loop that continously weakens the target server.
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);
        const amt = await ns.weaken(target)
        await log(ns, 'weaken', target, amt)
    }
}
 