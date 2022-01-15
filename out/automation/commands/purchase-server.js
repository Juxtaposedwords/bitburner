/** 
 * Buys a server of the specified RAM size.
 * 
 * @param {import("../../..").NS } ns */
export async function main(ns) {
	if (ns.args[0] == undefined) {
		ns.tprint("WARN: Usage: run purchaseServer.js <ram>")
		return;
	}

	// When you run this script, specify the target on the command line.
	const ram = Number(ns.args[0]);

	if (!isPowerOfTwo(ram)) {
		ns.tprint(`ERROR: ram (${ram}) must be a power of two.`)
		return;
	}

	const i = ns.getPurchasedServers().length;
	const hostname = ns.purchaseServer(`pserv-${i}`, ram);
	if (hostname == "") {
		ns.tprint(`ERROR: Failed to purchase server ${hostname}`)
		return;
	}
}
export function autocomplete(data, args) {
	return [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144]; // autocomplete powers of 2 for when the game goes CRAY
}

function isPowerOfTwo(x) {
	return (Math.log(x) / Math.log(2)) % 1 === 0
}
