// @ts-ignore
import { log } from "/automation/lib/log.js"

/**  hack continuously hacks the target server.
 * 
 *   It's careful not to drive the server down to 0, so that grow()
 *   scripts can be maximally effective.  This will never take so
 *   much money that the target is below 25% of its maximum.
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
    await log(ns, 'hack:start', target, 0);

    let threads = ns.getRunningScript().threads
    // never let available money go below the threshold of 25% of maximum,
    // so that grow() always has something to work with.
    const threshold = ns.getServerMaxMoney(target) / 4

    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);

        const availMoney = ns.getServerMoneyAvailable(target);
        if (availMoney < threshold) {
            continue;
        }
        // the amount of money each hack thread will take.
        const moneyPerThread = ns.hackAnalyze(target) * availMoney
        // the most money we can take without driving the target
        // below its threshold.
        const wantMoney = availMoney - threshold
        // the max number of threads we can use is enough to take all of wantMoney.
        const wantThreads = Math.floor(wantMoney / moneyPerThread)
        // hack() throws an error if you call it with more threads than the script is running with.
        const amt = await ns.hack(target, {threads: Math.min(threads, wantThreads)})
        await log(ns, 'hack', target, amt)
    }
}