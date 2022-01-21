/** 
 *  Kill everything running on all purchased servers.
 * @param {import("../../..").NS } ns */
export async function main(ns) {
	for (let hostname of ns.getPurchasedServers()) {
		ns.killall(hostname)
	}

	ns.tprint("INFO: killed all purchased servers.");
}