/**  hack-to-zero continuously hacks the target server until it's out of money.
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
    while (true) {
        // Always sleep in an infinite loop.
        await ns.sleep(100);

        const amt = await ns.hack(target)
        ns.print(`hacked ${target} for ${ns.nFormat(amt, '0.0a')}`)
        if (ns.getServerMoneyAvailable(target) < 1) {
            ns.print(`${target} out of money.`)
            break
        }
    }
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}