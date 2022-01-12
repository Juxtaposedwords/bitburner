/**
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length != 1) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  received %d arguments not 1.", ns.args.length);
        return;
    }
    var target = ns.args[0];
    var moneyThresh = ns.getServerMaxMoney(target) ;
    var securityThresh = ns.getServerMinSecurityLevel(target) + 5;
    while(true) {
        if (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target)) {
            await ns.weaken(target);
        } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}

