// @ts-ignore
import { pad } from "/automation/lib/pad.js";
// @ts-ignore
import { servers } from "/automation/lib/scan.js"

const fields = [
	"hostname",
	"hackingLevel",
	"securityLevel",
	"moneyAvailable",
	"maxMoney",
	"minSecurity",
	"backdoorInstalled",
]
/** @param {import("../../..").NS } ns */
export async function main(ns) {
	const data = ns.flags([
		["ports", "open"], // whether to use servers which have open ports or not
		["sort_by", "moneyAvailable"], // what to sort entries by
		["top", 0], // print only the top X entries. by default all are printed
	]);
	const which = data["ports"]
	let by = data["sort_by"]
	if (which != "open" && which != "closed") {
		ns.tprint("WARN:  Usage: run server-report.js --ports=(open|closed)")
		return
	}
	if (by == undefined) { by = "moneyAvailable" }
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
	const result = [[...fields]];

	for (let s of servers(ns)) {
		if (s == "home") {
			continue
		}
		const hasRoot = ns.hasRootAccess(s);
		if (which == "open" && !hasRoot) { continue }
		if (which == "closed" && hasRoot) { continue }
		result.push([
			s,
			ns.getServerRequiredHackingLevel(s),
			Math.floor(ns.getServerSecurityLevel(s)),
			Math.floor(ns.getServerMoneyAvailable(s)),
			ns.getServerMaxMoney(s),
			ns.getServerMinSecurityLevel(s),
			ns.getServer(s).backdoorInstalled,
		])
	}

	result.sort((a, b) => a[field] > b[field] ? -1 : 1);
	let formattedResults = []
	for (let i = 1; i < result.length; i++) {
		const r = result[i];
		r[3] = ns.nFormat(r[3], '0.0a');
		r[4] = ns.nFormat(r[4], '0.0a');
	}
	pad(ns, result)
	var limit = data['top'] != 0 && data['top'] < result.length ? data['top'] + 1 : result.length - 1;
	ns.tprint("\n" + result.slice(0, limit).map(s => s.join('')).join("\n"));
	return
}

export function autocomplete(data, args) {
	data.flags([
		["ports", "open"], // whether to use servers which have open ports or not
		["sort_by", "moneyAvailable"], // what to sort entries by
		["top", 0], // just give the top X entries
	])
	const options = {
		'ports': ["open", "closed"],
		'sort_by': fields,
	}

	for (let arg of args.slice(-2)) {
		if (arg.startsWith('--')) {
			return options[arg.slice(2)] || []
		}
	}
	return []
}