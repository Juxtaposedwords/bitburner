/** grow continuously grows the target server.
 *  @param {import("../../../..").NS } ns */
 export async function main(ns) {
     while (true){
        const money = await ns.getServerMoneyAvailable("home");
        if (ns.getUpgradeHomeRamCost() < money) {
            ns.upgradeHomeRam()
        } 
        if (ns.getUpgradeHomeCoresCost()<money){
            ns.upgradeHomeCores()
        }
        await ns.sleep(1000*60*10)
     }
 }