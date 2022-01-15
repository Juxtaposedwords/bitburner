/*  @param {import("../../..").NS } ns */

// start-hack.js copies all of the hacking scripts and libraries to the
// specified server and then runs the specified hacking script on it,
//  using as many threads as the server has available.
export async function main(ns) {
    const scripts = {
        "hack" : "/automation/util/hack.js",
        "grow" : "/automation/util/grow.js",
        "weaken" : "/automation/util/weaken.js",
        "ghw": "/automation/util/grow-hack-weak.js"
    }
    const script = scripts[ns.args[0]];
    if (script == undefined) {
        ns.tprint(`ERROR: script must be one of ${Object.keys(scripts)}`)
    }
    const server = ns.args[1]
    const target = ns.args[2]
    if (server == undefined || target == undefined) {
        ns.tprint("ERROR:  Usage: start-script <script> <server> <target>.")
        return
    }

    const files = [
        ...Object.values(scripts),
        ...ns.ls("home").filter(input => { return String(input).startsWith("/automation/lib/") }), // all of our libraries
    ];

    ns.killall(server)
    for (const f of files) {
        await ns.scp(f, "home", server)
    }
    const availRam = ns.getServer(server).maxRam - ns.getServer(server).ramUsed;
    const progRam = ns.getScriptRam(script, server);
    const memCount = (availRam / progRam)
    if (memCount < 1) {
        ns.tprintf(`ERROR: Not enough memory to run ${script} on ${server}.`)
        return;
    }
    ns.exec(script, server, memCount, target);
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}
