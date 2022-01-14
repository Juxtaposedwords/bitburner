/** @param {import("../../..").NS } ns */

// @ts-ignore
import { scan } from "/automation/lib/scan.js"

// Report the income for all scripts on all servers
export async function main(ns) {
    const result = []
    for (const server of scan(ns)) {
        for (const s of ns.ps(server)) {
            const inc = ns.getScriptIncome(s.filename, server, ...s.args)
            if (inc > 0) {
                result.push([server, s.filename + " " + s.args, inc])
            }
        }
    }
    result.sort(function(a, b) {
        // ascending order by server
        if (a[0] > b[0]) { return 1} 
        else if (a[0] < b[0]) { return -1 }
        // descending order by amount
        else if (a[1] < b[1]) { return 1 }
        else if (a[1] > b[1]) { return -1 }
        else return 0;
    })

    ns.tprint("\n" + result.map(s => [s[0], s[1], ns.nFormat(s[2], '0.0a')].join(",")).join("\n"));
}