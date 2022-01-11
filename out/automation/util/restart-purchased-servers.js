/** @param {import("../../..").NS } ns */

// Kill everything running on all purchased servers and restart them
// pointing at the new target.
export async function main(ns) {
	const target = ns.args[0]
    // TODO: These scripts don't presently exist.
	const scripts = [
		"hack-no-grow.js",
		"grow-server.js",
	];
	if (target == undefined) {
		ns.tprint("WARN: Usage: run restartPurchasedServers.js <target>")
		return;
	}

	const noGrowCount = 18; // the number of servers that will run hack-no-grow.
	let count = 0;
	for (let hostname of ns.getPurchasedServers()) {
		ns.killall(hostname)
		// Copy the latest version of the scripts.
		await ns.scp(scripts, "home", hostname);
		count++;
		let script = scripts[0];
		if (count > noGrowCount) {
			script = scripts[1];
		}
		const scriptRam = ns.getScriptRam(script);
		const threads = Math.floor(ns.getServerMaxRam(hostname) / scriptRam);
		ns.exec(script, hostname, threads, target);
	}

	ns.tprint("INFO: Restarted all purchased servers to target " + target + ".");
}