// @ts-ignore
import { toolCount } from "/automation/lib/cracks.js"



/** 
 * ghw uses the world's worst batch script and determines based on hack level and 
 * tools which target should be used.
 * @param {import("../../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["level", false]
    ])
    while (true) {
        const script = "/automation/commands/ghw-setup.js"
        let targets = ["n00dles", "joesguns", "silver-helix", "rho-construction","megacorp"]
        targets = targets.filter((name)=>{
            const server = ns.getServer(name)
            return server.hackDifficulty<=ns.getHackingLevel() && server.numOpenPortsRequired<=toolCount()
        })
        const target = targets.sort((l,r)=> targetValue(ns,l)-targetValue(ns,r))

        let args = ["--target", target]
        if (ns.getHackingLevel()>2000) {
            args.push("--level")
        }
        ns.exec(script, ns.getHostname(), 1, ...args)
        await ns.sleep(1000 * 60 * 5)
    }
}
/**
* @param {import("../../../..").NS } ns */
function targetValue(ns, target){
    const server = ns.getServer(target)
    if (isNaN(ns.getHackTime(target))){
        // if security is too high to hack, we discard it outright. 
        // In the case of --level we'll at least pass n00dles.
        return 0
    }
   const level_diff =  ns.getHackingLevel() -server.requiredHackingSkill;
   let level_mult = 1;
   let pow2_diff = Math.floor(Math.log(level_diff) / Math.log(2)) -2
   if (level_diff > 1 || pow2_diff>1){
       level_mult=Math.floor(level_diff/20)
   } 
   return server.moneyMax*level_mult
}

export function autocomplete(data, args) {
    data.flags([
        ["level", false],
    ])
    return []
}