/**  install-scripts.js installs the main hacking scripts and the /lib
 *   folder on the target server.
 * @param {import("../../..").NS } ns */
 export async function main(ns) {
	const flags = ns.flags([
		["server", null],  // the server that will run the scripts
	]);	
	const usage = "WARN: Usage: install-scripts.js --server <server>"
	if (flags.server == null)  {
		ns.tprint(usage)
		return;
	}
    const server = flags.server;
	if (!ns.hasRootAccess(server)) {
		ns.tprint(`WARN: root access required on ${server}.`)
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
 }