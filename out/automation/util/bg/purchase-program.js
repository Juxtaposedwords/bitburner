
// @ts-ignore
import { jsonLog } from "/automation/lib/log.js"


const files = [
    "BruteSSH.exe",
    "FTPCrack.exe",
    "relaySMTP.exe",
    "HTTPWorm.exe",
    "SQLInject.exe"]

/** grow continuously grows the target server.
 *  @param {import("../../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["program", ""],
        ["interval", 100 * 1000],
    ])
    if (!files.includes(flags.program)) {
        ns.tprintf(`ERROR: ${flags.program} is not one of ${files}`)
        return
    }
    while (!ns.fileExists(flags.program, "home")) {
        ns.purchaseProgram(flags.program)
        await ns.sleep(flags.interval)
    }

}

export function autocomplete(data, args) {
    data.flags([
        ["program", ""],
        ["interval", 100 * 1000],
    ])
    const options = {
        "program": files,
    }

    for (let arg of args.slice(-2)) {
        if (arg.startsWith('--')) {
            return options[arg.slice(2)] || []
        }
    }
}