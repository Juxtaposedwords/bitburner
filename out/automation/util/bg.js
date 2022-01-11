import { jsonLog } from  "/automation/lib/log.js"

/**
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length != 1) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  received %d arguments not 1.", ns.args.length);
        return;
    }
    var target = ns.args[0];
    var hacklevelOffset = Math.floor((ns.getHackingLevel-200) /100)*.7;
    var moneyThresh = ns.getServerMaxMoney(target) * (0.75-hacklevelOffset);
    var securityThresh = ns.getServerMinSecurityLevel(target) + 5;
    while(true) {
        if (ns.getServerSecurityLevel(target) > securityThresh) {
            await ns.weaken(target);
        } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}

