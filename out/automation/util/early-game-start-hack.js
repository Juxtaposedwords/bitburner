/** early-game-start-hack.js starts scripts that:
 *   weaken the target's security iteration,
 * 	 grow the target every iteration, and hack the target every iteration.
 * 
 * If the server doesn't have enough RAM to run all of these scripts with the
 *  required threads, this script will leave it alone.
 *  
 * @param {import("../../..").NS } ns */
export async function main(ns) {
	const server = String(ns.args[0]);  // the server that will run the scripts
	const target = String(ns.args[1]);  // the target server
	const threads = Number(ns.args[2]); // the number of threads to use for each script
	const usage = "WARN: Usage: early-start-hack.js <server> <target> <threads>"
	if (ns.args[0] == undefined || ns.args[1] == undefined || ns.args[2] == undefined) {
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

	const weakenThreads = threads;
	const growThreads = threads;
	const hackThreads = threads;

	const weakenRam = ns.getScriptRam("/automation/util/weaken.js");
	const growRam = ns.getScriptRam("/automation/util/grow.js");
	const hackRam = ns.getScriptRam("/automation/util/hack.js")

	//ns.tprint(`weakenThreads=${weakenThreads}, growThreads=${growThreads}, hackThreads=${hackThreads}`)

	const neededRam = (weakenRam * weakenThreads + growRam * growThreads + hackRam * hackThreads)
	const availRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)

	//ns.tprint(`neededRam=${neededRam}, availRam=${availRam}`);

	if (neededRam > availRam) {
		ns.tprint(`ERROR: not enough RAM: ${neededRam} needed, ${availRam} available.`)
		return;
	}

	ns.exec("/automation/util/weaken.js", server, weakenThreads, target);
	ns.exec("/automation/util/grow.js", server, growThreads, target);
	ns.exec("/automation/util/hack.js", server, hackThreads, target);
}