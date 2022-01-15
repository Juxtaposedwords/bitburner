/** @param {import("../../..").NS } ns */

// @ts-ignore
import { pad } from "./automation/lib/pad.js";
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
		["pretty", false], // determines whether to use pretty format or not
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

	for (let i = 1; i < result.length; i++) {
		const r = result[i];
		r[3] = ns.nFormat(r[3], '0.0a');
		r[4] = ns.nFormat(r[4], '0.0a');
	}
	if (!data['pretty']) {
		pad(ns, result)
		ns.tprint("\n" + result.map(s => s.join('')).join("\n"));
		return
	}
	result.shift()
	if (!data['pretty'] && data['top'] > 0) {
		ns.tprintf("ERROR: invalid usage. Cannot use top without specifying pretty")
		return
	}

	var length = (data['top'] > 0 && result.length > data['top']) ? data['top'] : result.length;
	for (let i = 1; i < length+1; i++) {
		ns.tprintf("%s\n", result[i][0])
		ns.tprintf("  Hack Level      : %d\n", result[i][1])
		ns.tprintf("  Security Level  : %d\n", result[i][2])
		ns.tprintf("  Min. Sec. Level : %d\n", result[i][5])
		ns.tprintf("  Money Available : $%s\n", result[i][3])
		ns.tprintf("  Max Money       : $%s\n", result[i][4])
		ns.tprintf("  Backdoored      : %t\n", result[i][6])

	}
}

export function autocomplete(data, args) {
	data.flags([
		["ports", "open"], // whether to use servers which have open ports or not
		["sort_by", "moneyAvailable"], // what to sort entries by
		["pretty", false], // determines whether ot use pretty format or not
		["top", 0], // print only the top X entries. by default all are printed
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