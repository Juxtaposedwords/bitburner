
// @ts-ignore
import { tools } from "/automation/lib/cracks.js"

/** grow continuously grows the target server.
 *  @param {import("../../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["program", ""],
        ["interval", 100 * 1000],
    ])
    if (!tools().includes(flags.program)) {
        ns.tprintf(`ERROR: ${flags.program} is not one of ${tools()}`)
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
        "program": tools(),
    }

    for (let arg of args.slice(-2)) {
        if (arg.startsWith('--')) {
            return options[arg.slice(2)] || []
        }
    }
}