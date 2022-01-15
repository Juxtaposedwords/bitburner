// @ts-ignore
import { pad } from "./automation/lib/pad.js";
import { servers } from "/automation/lib/scan.js"

const fields = [
	"hostname",
	"scriptName",
	"target",
	"threads",
	"income",
	"expGain",
]
/** @param {import("../../..").NS } ns */
export async function main(ns) {
	const data = ns.flags([
		["sort_by", "hostname"], // what to sort entries by
		["top", 0], // print only the top X entries. by default all are printed
	]);
	let by = data["sort_by"]
	if (by == undefined) { by = "hostname" }
	let field = undefined;
	for (let i = 0; i < fields.length; i++) {
		if (by == fields[i]) {
			field = i;
			break;
		}
	}
	if (field == undefined) {
		ns.tprint("ERROR: unknown field " + by + ", valid values are " + fields.join(',') + ".");
		return;
	}
	const result = [];

	for (let sr of servers(ns)) {
		for (let p of ns.ps(sr)) {
			if (p.filename.endsWith("script-report.js")) {
				continue
			}
			const inc = ns.getScriptIncome(p.filename, sr, ...p.args)
			const exp = ns.getScriptExpGain(p.filename, sr, ...p.args)
			const f = p.filename.split("/")
			result.push([sr, f[f.length-1], p.args, p.threads, inc, Math.floor(exp*100)/100])
		}
	}

	result.sort((a, b) => a[field] > b[field] ? -1 : 1);

	result.forEach((r, i) => result[i][4] = ns.nFormat(r[4], '0.0a'));

	result.unshift([...fields]) // copy fields, so pad() doesn't modify a global constant

	pad(ns, result)
	ns.tprint("\n" + result.map(s => s.join('')).join("\n"));
	return
}

export function autocomplete(data, args) {
	data.flags([
		["sort_by", "hostname"], // what to sort entries by
	])
	const options = {
		'sort_by': fields,
	}
	for (let arg of args) {
		if (arg.startsWith('--')) {
			return options[arg.slice(2)] || []
		}
	}
	return []
}