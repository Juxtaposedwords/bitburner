/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["server", null],
        ["target", null],
    ])
    const server = flags.server
    const target = flags.target
    if (server == null || target == null) {
        ns.tprint("WARN: Usage: clone-server --server <server> --target <target>.")
        return
    }

    if (!ns.serverExists(server)) {
        ns.tprint(`ERROR: unknown server: ${server}.`)
        return
    }
    if (!ns.serverExists(target)) {
        ns.tprint(`ERROR: unknown server: ${target}.`)
        return
    }
    if (target == "home") {
        ns.tprint(`ERROR: home cannot be a clone destination.`)
        return
    }

    const ss = ns.getServer(server);
    const ts = ns.getServer(target);
    if (ss.maxRam > ts.maxRam) {
        ns.tprint(`ERROR: ${server} has more max RAM than ${target}`)
        return
    }

    ns.killall(target)

    for (let file of ns.ls(target)) {
        ns.rm(file, target);
    }

    await ns.scp(ns.ls(server), server, target);

    for (let p of ns.ps(server)) {
        ns.exec(p.filename, target, p.threads, ...p.args);
    }
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}