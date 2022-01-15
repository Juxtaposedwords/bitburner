/** @param {import("../../..").NS } ns */

import { scan } from "./automation/lib/scan.js"
import { pad } from "./automation/lib/pad.js"

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
        // descending order by amount
         if (a[2] < b[2]) { return 1 }
        else if (a[2] > b[2]) { return -1 }
        else return 0;
    })
    result.forEach((s, i) => result[i][2] = ns.nFormat(s[2], '0.0a'))

    pad(ns, result);
    ns.tprint("\n" + result.map(s => s.join('')).join("\n"));
}

