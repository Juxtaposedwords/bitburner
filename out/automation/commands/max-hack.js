/**  max-hack.js will launch hack.js on the server with as many
 *   threads as available RAM will support.  It will then use any RAM
 *   left over to run weaken.js.
 * @param {import("../../..").NS } ns */
 export async function main(ns) {
	const flags = ns.flags([
		["server", null],  // the server that will run the scripts
		["target", null],  // the target server
	]);	
	const usage = "WARN: Usage: max-hack.js --server <server> --target <target>"
	if (flags.server == null || flags.target == null) {
		ns.tprint(usage)
		return;
	}
	const server = flags.server;
    if (server == "home") {
        ns.tprint(`ERROR: don't run this on home.  Just don't.`)
        return
    }
	const target = flags.target;
	if (!ns.hasRootAccess(target)) {
		ns.tprint(`WARN: root access required on ${target}.`)
		return;
	}

    ns.killall(server)

	const hackRam = ns.getScriptRam("/automation/util/hack.js");
	let availRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)
    const hackThreads = Math.floor(availRam / hackRam)

	if (hackThreads < 1) {		
		const nf = ns.nFormat
		ns.tprint(`ERROR: not enough RAM: ${nf(hackRam, '0.0a')} needed, ${nf(availRam, '0.0a')} available.`)
		return;
	}
	ns.exec("/automation/util/hack.js", server, hackThreads, target);

    availRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)
	const weakenRam = ns.getScriptRam("/automation/util/weaken.js");
	availRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server)
    const weakenThreads = Math.floor(availRam / weakenRam)
    if (weakenThreads >= 1) {
        ns.exec("/automation/util/weaken.js", server, weakenThreads, target);
    }
}
export function autocomplete(data, args) {
	data.flags([
		["server", null],  // the server that will run the scripts
		["target", null],  // the target server
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