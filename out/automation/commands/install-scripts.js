/**  install-scripts.js installs the main hacking scripts and the /lib
 *   folder on the target server.
 * @param {import("../../..").NS } ns */
 export async function main(ns) {
	const usage = "WARN: Usage: install-scripts.js <server>"
	if (ns.args.length < 1)  {
		ns.tprint(usage)
		return;
	}
    const server = String(ns.args[0]);
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

export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
}