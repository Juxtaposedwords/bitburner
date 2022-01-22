/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["source", null],
        ["target", null],
    ])
    const source = flags.source
    const target = flags.target
    if (source == null || target == null) {
        ns.tprint("WARN: Usage: clone-server --source <source> --target <target>.")
        return
    }

    if (!ns.serverExists(source)) {
        ns.tprint(`ERROR: unknown server: ${source}.`)
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

    const ss = ns.getServer(source);
    const ts = ns.getServer(target);
    if (ss.maxRam > ts.maxRam) {
        ns.tprint(`ERROR: ${source} has more max RAM than ${target}`)
        return
    }

    ns.killall(target)

    for (let file of ns.ls(target)) {
        ns.rm(file, target);
    }

    await ns.scp(ns.ls(source), source, target);

    for (let p of ns.ps(source)) {
        ns.exec(p.filename, target, p.threads, ...p.args);
    }
}

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}