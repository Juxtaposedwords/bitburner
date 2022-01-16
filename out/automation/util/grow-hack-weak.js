/**
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    if (ns.args.length != 1) {
        ns.tprintf("ERROR: Usage: run `grow.js <target>`.  received %d arguments not 1.", ns.args.length);
        return;
    }
    var target = String(ns.args[0]);

    // we could add a check for our purchased servers, but let's tyr and keep this script as lean as possible.
    if ( target == "home" || target.startsWith("pserv")){
        ns.tprintf("ERROR: cannot target home or a personal server")
        return
    }
    if (target ==""){
        target =ns.getHostname()
    }
    var securityThresh =  ns.getServerMinSecurityLevel(target) + 10
    var moneyThresh = ns.getServerMaxMoney(target)*.80 ;
    while(true) {
        if (ns.getServerSecurityLevel(target) >securityThresh) {
            await ns.weaken(target);
       // } else if (ns.getServerMoneyAvailable(target) == 0) {
            // So grow() will grant no money and hack() will take no money.
        //    ns.tprintf("ERROR: %s has no money available.", target)
      //      return
        }  else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}

