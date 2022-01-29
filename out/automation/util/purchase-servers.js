/** Runs continuously until it has bought all servers you can buy
 *  (it will wait until you can afford them).  Each purchased server
 * will have purchased-server-hack.js installed on it.
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
	// When you run this script, specify the target on the command line.
	let ramInput =Number(ns.args[0])
	const ram = Math.pow(2, Number(ramInput));
	const minMoneyThreshold = (ns.args[1] == undefined) ? 0 : Number(ns.args[2]);

	if (ns.args[0] == undefined) {
		ns.tprint("WARN: Usage: run purchaseServers.js <ram> <target>")
		return;
	}
	if (ramInput > 20 || ramInput < 1) {
		ns.tprint(`ERROR: ram (${ram}) must be between 1 and 20.`)
		return;
	}



	// Suffix for server names.
	let i = ns.getPurchasedServers().length;
	while (ns.getServerMoneyAvailable("home") > minMoneyThreshold && i < ns.getPurchasedServerLimit()) {
		await ns.sleep(500);
		// Check if we have enough money to purchase a server.  If we don't,
		// this script will wait until we do.  This is useful in the early
		// game when you don't have enough money to buy up to the limit.
		if (ns.getServerMoneyAvailable("home") < ns.getPurchasedServerCost(ram)) {
		//	ns.tprintf(`sleeping as server Money: ${ns.getServerMoneyAvailable("home")} < ${ns.getPurchasedServerCost(ram)}`)
			continue;
		}
		const hostname = ns.purchaseServer("pserv-" + i, ram);
		if (hostname == "") {
			ns.tprint("ERROR: Failed to purchase server " + hostname)
			return;
		}
		ns.exec("/automation/commands/init-purchased-server.js", ns.getHostname(), 1, ...["--server", hostname])

		i++;
	}
	ns.tprint("INFO: Congratulations, purchased server limit of " + i + " reached.")
}