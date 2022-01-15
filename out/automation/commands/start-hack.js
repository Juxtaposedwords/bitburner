/*  @param {import("../../..").NS } ns */

// start-hack.js copies all of the hacking scripts and libraries to the
// specified server and then runs hack.js on it using as many threads
// as the server has available.
export async function main(ns) {
    var server = ns.args[0]
    var target = ns.args[1]
    if (server == undefined || target == undefined) {
        ns.tprint("ERROR:  Usage: start-hack <server> <target>.")
        return
    }

    const hack = "/automation/util/hack.js";
    const grow = "/automation/util/grow.js";
    const weaken = "/automation/util/weaken.js"
    const ghw = "/automation/util/grow-hack-weak.js";

    const files = [
        hack, grow, weaken, ghw,
        ...ns.ls("home").filter(input => { return String(input).startsWith("/automation/lib/") }), // all of our libraries
    ];

    ns.killall(server)
    for (const f of files) {
        await ns.scp(f, "home", server)
    }
    const availRam = ns.getServer(server).maxRam - ns.getServer(server).ramUsed;
    const progRam = ns.getScriptRam(hack, server);
    const memCount = (availRam / progRam)
    if (memCount < 1) {
        ns.tprintf(`ERROR: Not enough memory to run hack.js on ${server}.`)
        return;
    }
    ns.exec(hack, server, memCount, target);
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}
