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
	const server = String(ns.args[0]); // the server that will run the scripts
	const target = String(ns.args[1]); // the target server
	const usage = "WARN: Usage: start-hack.js <server> <target>"
	if (ns.args[0] == undefined || ns.args[1] == undefined) {
		ns.tprint(usage)
		return;
	}
	if (!ns.hasRootAccess(target)) {
		ns.tprint(`WARN: root access required on ${target}.`)
		return;
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
		// let's not log this to the console, it's super spammy.
		ns.tprint(`ERROR: not enough RAM: ${neededRam} needed, ${availRam} available.`)
		return;
	}

	ns.exec("/automation/util/weaken.js", server, weakenThreads, target);
	ns.exec("/automation/util/grow.js", server, growThreads, target);
	ns.exec("/automation/util/hack.js", server, hackThreads, target);
}