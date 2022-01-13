/** @param {import("../../..").NS } ns */

// Runs continuously until it has bought all servers you can buy
// (it will wait until you can afford them).  Each purchased server
// will have purchased-server-hack.js installed on it.

function isPowerOfTwo(x) {
	return (Math.log(x) / Math.log(2)) % 1 === 0
}

export async function main(ns) {
	// When you run this script, specify the target on the command line.
	const ram = Number(ns.args[0]);
	const target = String(ns.args[1]);
	const minMoneyThreshold = (ns.args[2] == undefined) ? 0 : ns.args[2];

	if (target == undefined || ram == undefined) {
		ns.tprint("WARN: Usage: run purchaseServers.js <ram> <target>")
		return;
	}

	if (!isPowerOfTwo(ram)) {
		ns.tprint("ERROR: ram (" + ram + ") must be a power of two.")
		return;
	}
	if (!ns.serverExists(target)) {
		ns.tprint("ERROR: server " + target + " does not exist.")
		return;
	}
	const scriptName = "/automation/util/grow-hack-weak.js"
	const scriptRam = ns.getScriptRam(scriptName);
	const threads = Math.floor(ram / scriptRam);

	// Suffix for server names.
	let i = ns.getPurchasedServers().length;

	while (ns.getServerMoneyAvailable("home") > minMoneyThreshold && i < ns.getPurchasedServerLimit()) {
		await ns.sleep(500);
		// Check if we have enough money to purchase a server.  If we don't,
		// this script will wait until we do.  This is useful in the early
		// game when you don't have enough money to buy up to the limit.
		if (ns.getServerMoneyAvailable("home") < ns.getPurchasedServerCost(ram)) {
			continue;
		}
		const hostname = ns.purchaseServer("pserv-" + i, ram);
		if (hostname == "") {
			ns.tprint("ERROR: Failed to purchase server " + hostname)
			return;
		}
		const files = [
			scriptName,
		]
		await ns.scp(files, hostname);
		if (ns.exec(scriptName, hostname, threads, target) == 0) {
			ns.tprint("ERROR: Launching " + scriptName + " failed on hostname " + hostname);
			return;
		}
		i++;
	}
	ns.tprint("INFO: Congratulations, purchased server limit of " + i + " reached.")
}