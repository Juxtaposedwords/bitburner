// @ts-ignore
import { scan } from "/automation/lib/scan.js"

export async function root(ns, target, verbose=false) {
    return basicRoot(ns, target, false, verbose)
}
export async function safeRoot(ns, target, verbose=false) {
    return basicRoot(ns, target, true, verbose)
}

/** @param {import("../../..").NS } ns */
function basicRoot(ns, target, safe, verbose=false){
    const cracks = [
        ["FTPCrack.exe", ns.ftpcrack],
        ["BruteSSH.exe", ns.brutessh],
        ["HTTPWorm.exe", ns.httpworm],
        ["relaySMTP.exe", ns.relaysmtp],
        ["SQLInject.exe", ns.sqlinject],
    ]

    let ports = 0;
    for (const c of cracks) {
        if (ns.fileExists(String(c[0]), "home")) {
            c[1](target);
            ports++;
        }
    }
    const log = (f, ...s) => {
        if (verbose) {
            ns.tprintf(f, s);
        }
    }
    const needed = ns.getServerNumPortsRequired(target)
    if (ports < needed) {
        log("WARN: Not enough ports opened for target " + target + "; needed " + needed, ", got " + ports + ".");
    } else if (ns.hasRootAccess(target)==true) {
        log("INFO: skipping rooting %s as is already rooted",target)
    } else if ((safe) && (ns.getHackingLevel()< ns.getServerRequiredHackingLevel(target))){
        log("INFO: skipping rooting %s as %d is higher than current hacking level (%d)",0, ns.getHackingLevel())
    } else { 
        ns.nuke(target);
        if (!(ns.hasRootAccess(target) == true )){
            ns.tprintf("ERROR: Failed to nuke target: %s",target)
        }
    }
    return ns.hasRootAccess(target)
}


/** @param {import("../../..").NS } ns */
export async function rootAll(ns) {
    for (const server of scan(ns).filter(server =>{
        const serverStats = ns.getServer(server)
        return (!serverStats.hasAdminRights && ns.getHackingLevel() >= serverStats.hackDifficulty) 
    })){
        root(ns, server,false)
    }
}