/** 
 * bg is used to run command in the background.  
 * Ideally we wouldn't need this but netscript isn't really asynch sadly
 * @param {import("../../../..").NS } ns */
export async function main(ns) {
    const script = String(ns.args[0])
    const interval = Number(ns.args[1])
    const threads = Number(ns.args[2])
    if (ns.args[0] == undefined || ns.args[1] == undefined || ns.args[2] == undefined) {
        ns.tprintf(`ERROR: Syntax is "watch.js {script} {interval} {threads}."\n Instead got: "watch.js ${script} ${interval} ${threads}"`)
    }
    if (!ns.fileExists(script)) {
        ns.tprintf("ERROR: file %s does not exists", script)
        return
    }
    if (interval < 10) {
        ns.tprintf("ERROR: inteval must be at least 100 ms")
    }
    while (true) {
        ns.exec(script, ns.getHostname(), threads, ...ns.args.slice(3))
        await ns.sleep(interval)
    }
}

export function autocomplete(data, args) {
    if (args.length == 1) {
        return data.scripts
    }
    return []
}