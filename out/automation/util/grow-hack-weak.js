// @ts-ignore
import { safeRoot } from "/automation/lib/root.js";

/**
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length != 1) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  received %d arguments not 1.", ns.args.length);
        return;
    }
    var target = String(ns.args[0]);
    var moneyThresh = ns.getServerMaxMoney(target) ;
    while(true) {
        if (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target)) {
            await ns.weaken(target);
        } else if (ns.getServerMoneyAvailable(target) == 0) {
            // So grow() will grant no money and hack() will take no money.
            ns.tprintf("ERROR: %s has no money available.", target)
            return
        }  else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}
