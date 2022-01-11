/** @param {import("../../..").NS } ns */

// Basic hack script that gets root on the target (if possible)
// and then does a standard weaken/grow/hack loop.
async function standardHack(ns, target) {
    const moneyThresh = ns.getServerMaxMoney(target) * 0.75;
    const securityThresh = ns.getServerMinSecurityLevel(target) + 5;

    if (!getRoot(ns, target)) {
        ns.tprint("WARN: Unable to get root on target " + target + ".");
        return
    }

    // Infinite loop that continously hacks/grows/weakens the target server
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);
        // If the server's security level is above our threshold, weaken it
        if (ns.getServerSecurityLevel(target) > securityThresh) {
            await ns.weaken(target);
            continue;
        }
        // If the server's money is less than our threshold, grow it
        if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
            continue;
        }
        await ns.hack(target);
    }
}

function getRoot(ns, target) {

    const cracks = [
        ["FTPCrack.exe", ns.ftpcrack],
        ["BruteSSH.exe", ns.brutessh],
        ["HTTPWorm.exe", ns.httpworm],
        ["relaySMTP.exe", ns.relaysmtp],
        ["SQLInject.exe", ns.sqlinject],
    ]

    let ports = 0;
    for (const c of cracks) {
        if (ns.fileExists(c[0], "home")) {
            c[1](target);
            ports++;
        }
    }
    const needed = ns.getServerNumPortsRequired(target)
    if (ports < needed) {
        ns.tprint("WARN: Not enough ports opened for target " + target + "; needed " + needed, ", got " + ports + ".");
    } else {
        ns.nuke(target);
    }

    return ns.hasRootAccess(target);
}

export async function main(ns) {
    const target = ns.args[0];
    await standardHack(ns, target);
}