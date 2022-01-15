
// @ts-ignore
import { log } from  "/automation/lib/log.js"

/** grow continuously grows the target server.
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args[0] == undefined) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  recved %d arguments not 1.", ns.args.length);
        return;
    }
    const target = String(ns.args[0])
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: Need root access on ${target}.`);
        return;
    }
    await log(ns, 'grow:start', target, 0);
 
    // Infinite loop that continously hacks the target server
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);
        const amt = await ns.grow(target)
        await log(ns, 'grow', target, amt)
    }
}