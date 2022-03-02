// @ts-ignore
import { allServers } from "/automation/lib/scan.js"
// @ts-ignore
import { pad } from "/automation/lib/pad.js"

/**  Report the income for all scripts on all servers
* @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["by_target", false]
    ])
    const result = []
    let total = 0
    for (const server of allServers(ns)) {
        for (const s of ns.ps(server)) {
            const inc = ns.getScriptIncome(s.filename, server, ...s.args)
            if (inc > 0) {
                result.push([server, s.filename + " " + s.args, inc])
                total += inc
            }
        }
    }
    if (result.length == 0) {
        ns.tprint("WARN: No scripts are making money!")
        return;
    }

    if (!flags.by_target){
        result.sort(function(a, b) {
            // descending order by amount
            if (a[2] < b[2]) { return 1 }
            else if (a[2] > b[2]) { return -1 }
            else return 0;
        })
        result.forEach((s, i) => result[i][2] = ns.nFormat(s[2], '0.0a'))
        result.push(['', 'TOTAL:', ns.nFormat(total, '0.0a')])
        pad(ns, result);
        ns.tprint("\n" + result.map(s => s.join('')).join("\n"));
        return
    }

    const totals = {}
    result.forEach(function(r) {
        const target = r[1].split(' ').slice(-1)
        totals[target] = (totals[target] == undefined ? 0 : totals[target]) + r[2]
    })
    const out = Object.keys(totals).map(k => [k, totals[k]])
    out.sort((a, b) => a[1] > b[1] ? -1 : 1)
    out.forEach((s, i) => out[i][1] = ns.nFormat(out[i][1], '0.0a'))
    out.push(['TOTAL:', ns.nFormat(total, '0.0a')])
    pad(ns, out)
    ns.tprint("\n" + out.map(s => s.join('')).join("\n"));
}

export function autocomplete(data, args) {
	data.flags([
		["sort_by", "hostname"], // what to sort entries by
	])
}