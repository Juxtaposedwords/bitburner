// @ts-ignore
import { scan } from "/automation/lib/scan.js";

/**
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length < 1) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  received %d arguments not 1.", ns.args.length);
        return;
    }
    var target = String(ns.args[0]);
    var mode = ns.args.length == 2 ? "level" : "money"

    // we could add a check for our purchased servers, but let's tyr and keep this script as lean as possible.
    if (target == "home" || target.startsWith("pserv")) {
        ns.tprintf("ERROR: cannot target home or a personal server")
        return
    }
    if (target == "") {
        target = ns.getHostname()
    }
    var securityThresh = ns.getServerMinSecurityLevel(target) + 5
    var moneyThresh = ns.getServerMaxMoney(target) * .25;
    while (true) {
        const secureServers = scan(ns).filter(name => {
            const server = ns.getServer(name)
            return server.hackDifficulty - server.minDifficulty >= 35 && server.hasAdminRights
        })
        if (secureServers.length > 1 && mode =="level") {
            await ns.weaken(secureServers[Math.floor((Math.random()*secureServers.length))])
        }
        else if (ns.getServerSecurityLevel(target) > securityThresh) {
            await ns.weaken(target);
            // } else if (ns.getServerMoneyAvailable(target) == 0) {
            // So grow() will grant no money and hack() will take no money.
            //    ns.tprintf("ERROR: %s has no money available.", target)
            //      return
        } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}

