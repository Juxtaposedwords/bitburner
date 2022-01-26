/**  start-hack.js starts scripts that:
 * 
 * weaken the target's security by 20 every iteration,
 * grow the target by 4 every iteration, and
 * hack the target for 25% of its money every iteration.
 * 
 * This is mostly heuristic; it seems to keep the target servers in
 * money and hackable.
 * 
 * If the server doesn't have enough RAM to run all of these script
 * with the required threads, this script will leave it alone.
 * @param {import("../../..").NS } ns */
export async function main(ns) {
	const flags = ns.flags([
		["server", null],  // the server that will run the scripts
		["target", null],  // the target server
		["verbose", false], // print errors if launching the scripts fails
	]);	
	const usage = "WARN: Usage: start-hack.js --server <server> --target <target>"
	if (flags.server == null || flags.target == null) {
		ns.tprint(usage)
		return;
	}
	const server = flags.server;
	const target = flags.target;
	if (!ns.hasRootAccess(target)) {
		ns.tprint(`WARN: root access required on ${target}.`)
		return;
	}
	let print = ns.print
	if (flags.verbose) {
		print = ns.tprint
	}

	if (server != "home") {
		await ns.scp([
			"/automation/util/weaken.js",
			"/automation/util/grow.js",
			"/automation/util/hack.js",
			"/automation/lib/log.js",
		], "home", server)
	}

	const weakenThreads = 400
	const growThreads = Math.floor(ns.growthAnalyze(target, 4));
	const hackThreads = Math.floor(.25 / ns.hackAnalyze(target))

	const weakenRam = ns.getScriptRam("/automation/util/weaken.js");
	const growRam = ns.getScriptRam("/automation/util/grow.js");
	const hackRam = ns.getScriptRam("/automation/util/hack.js")

	const neededRam = (weakenRam * weakenThreads + growRam * growThreads + hackRam * hackThreads)
	const availRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)

	if (neededRam > availRam) {		
		const nf = ns.nFormat
		print(`ERROR: not enough RAM: ${nf(neededRam, '0.0a')} needed, ${nf(availRam, '0.0a')} available.`)
		return;
	}
	ns.exec("/automation/util/weaken.js", server, weakenThreads, target);
	ns.exec("/automation/util/grow.js", server, growThreads, target);
	ns.exec("/automation/util/hack.js", server, hackThreads, target);
}
export function autocomplete(data, args) {
	data.flags([
		["server", null],  // the server that will run the scripts
		["target", null],  // the target server
		["verbose", false], // print errors if launching the scripts fails
	])
	const options = {
		"server": data.servers,  // the server that will run the scripts
		"target": data.servers,  // the target server
	}

	for (let arg of args.slice(-2)) {
		if (arg.startsWith('--')) {
			return options[arg.slice(2)] || []
		}
	}
	return []
}