/** @param {import("../../..").NS } ns */

import { servers } from "/automation/lib/scan.js"

export async function main(ns) {
	const data = ns.flags([
		["ports", "open"], // whether to use servers which have open prots or not
		["sort_by", "moneyAvailable"], // what to sort entries by
		["pretty", false], // determines whether ot use pretty format or not
		["top", 0], // print only the top X entries. by default all are printed
	]);
	const which = data["ports"]
	let by = data["sort_by"]
	if (which != "open" && which != "closed") {
		ns.tprint("WARN:  Usage: run server-report.js open|closed ?sort-by")
		return
	}
	if (by == undefined) { by = "moneyAvailable" }
	const fields = [
		"hostname",
		"hackingLevel",
		"securityLevel",
		"moneyAvailable",
		"maxMoney",
	]
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
		])
	}

	result.sort((a, b) => a[field] > b[field] ? -1 : 1);

	for (let i = 1; i < result.length; i++) {
		const r = result[i];
		r[3] = ns.nFormat(r[3], '0.0a');
		r[4] = ns.nFormat(r[4], '0.0a');
	}
	if (!data['pretty']) {
		ns.tprint("\n" + result.join('\n'));
		return
	} 
	result.shift()

	if (!data['pretty'] && data['top'] > 0) {
		ns.tprintf("ERROR: invalid usage. Cannot use top without specifying pretty")
		return
	}

	var length = (data['top']>0 && result.length>data['top']) ? data['top'] : result.length; 
	for (let i = 1; i < length; i++) {
		ns.tprintf("%s\n", result[i][0])
		ns.tprintf("  Hack Level      : %d/%d\n", result[i][1],result[i][5])
		ns.tprintf("  Security Level  : %d\n", result[i][2])
		ns.tprintf("  Money Available : $%s\n", result[i][3])
		ns.tprintf("  Max Money       : $%s\n", result[i][4])
	}


}