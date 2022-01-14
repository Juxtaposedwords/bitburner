// @ts-ignore
import { servers } from "/automation/lib/scan.js"

const fields = [
	"hostname",
	"hackingLevel",
	"securityLevel",
	"moneyAvailable",
	"maxMoney",
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
	const result = [fields];

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
		r[0] = String(r[0]).padEnd(20, " ");
		r[1] = String(r[1]).padEnd(9, " ");
		r[2] = String(r[5] + "/" + r[2]).padEnd(7, " ");
		r[3] = ns.nFormat(r[3], '0.0a').padEnd(8, " ");
		r[4] = ns.nFormat(r[4], '0.0a').padEnd(8, " ");
		r[5] = ""
		formattedResults.push(r.join(" "))
	}
	formattedResults.unshift( "HostName".padEnd(21) + "Hack".padEnd(10, " ") + "Sec".padEnd(8, " ") + "Avail $".padEnd(9, " ") + "Max $".padEnd(10, " ") + "Backdoor")

	ns.tprint("\n" + formattedResults.join('\n'));
}

export function autocomplete(data, args) {
	data.flags([
		["ports", "open"], // whether to use servers which have open ports or not
		["sort_by", "moneyAvailable"], // what to sort entries by
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