// @ts-ignore
import { jsonLog } from  "/automation/lib/log.js"

/**  hack continuously hacks the target server.
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args[0] == undefined) {
        ns.tprint("INFO: Usage: run hack.js <target>");
        return;
    }
    const target = String(ns.args[0])
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: Need root access on ${target}.`);
        return;
    }
    const log = async  function(message){
		await jsonLog(ns,
			"hack.js",message, {"target": target,})
	}
    await log(`Starting hack for ${target}`);

    // Infinite loop that continously hacks the target server
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);
        const maxMoney = ns.getServerMaxMoney(target);
        const availMoney = ns.getServerMoneyAvailable(target);
        // TODO:  With high enough hack skill, this doesn't keep the script from
        // zeroing out the server.
        if (availMoney * 4 < maxMoney) {
            continue;
        }
        const amt = await ns.hack(target)
        await log(`hacked ${target} for ${amt}`)
    }
}