// @ts-ignore
import { jsonLog } from  "/automation/lib/log.js"

// weaken continuously weakens the target server.
/**
 * @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length < 1) {
        ns.tprintf("ERROR: Usage: run weaken.js <target>.  Received %d arguments not 1.", ns.args.length);
        return;
    }
    const target = String(ns.args[0])
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: Need root access on ${target}.`);
        return;
    }
	const log = async  function(message){
		await jsonLog(ns,
			"weaken.js",message, {"target": target,})
	}
    await log(`Started weaking: ${target}`);
 
    // Infinite loop that continously weakens the target server.
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);
        const amt = await ns.weaken(target)
        await log(`Weakened ${target} for ${amt}`)
    }
}
 
export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}