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
	const flags = ns.flags([
		["ports", "open"], // whether to use servers which have open ports or not
		["sort_by", "moneyAvailable"], // what to sort entries by
		["top", 0], // print only the top X entries. by default all are printed
		["unused", false], // report only servers with 100% free RAM
		["hackable", false], // report only servers we can hack
	]);
	if (flags.ports != "open" && flags.ports != "closed") {
		ns.tprint("WARN:  Usage: run server-report.js --ports=(open|closed)")
		return
	}
	let by = flags.sort_by
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
	
	let result = [];

	for (let s of servers(ns)) {
		if (s == "home") {
			continue
		}
		const srv = ns.getServer(s)
		if (flags.unused) {
			if (srv.maxRam == 0) { continue }
			if (srv.ramUsed != 0) { continue }
		}		
		const hasRoot = ns.hasRootAccess(s);
		if (flags.ports == "open" && !hasRoot) { continue }
		if (flags.ports == "closed" && hasRoot) { continue }
		if (flags.hackable && ns.getServerRequiredHackingLevel(s) > ns.getHackingLevel()) {
			continue
		}
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

	if (flags.top > 0 && flags.top < result.length) {
		result = result.slice(0, flags.top);
	}
	
	for (let i = 0; i < result.length; i++) {
		const r = result[i];
		r[3] = ns.nFormat(r[3], '0.0a');
		r[4] = ns.nFormat(r[4], '0.0a');
	}

  if (!flags.pretty) {
		result.unshift([...fields]); // copy fields here, so that pad doesn't modify a global variable.
		pad(ns, result)
		ns.tprint("\n" + result.map(s => s.join('')).join("\n"));
		return
	}

	for (let r of result) {
		ns.tprintf("%s\n", r[0])
		ns.tprintf("  Hack Level      : %d\n", r[1])
		ns.tprintf("  Security Level  : %d\n", r[2])
		ns.tprintf("  Min. Sec. Level : %d\n", r[5])
		ns.tprintf("  Money Available : $%s\n", r[3])
		ns.tprintf("  Max Money       : $%s\n", r[4])
		ns.tprintf("  Backdoored      : %t\n", r[6])
	}
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