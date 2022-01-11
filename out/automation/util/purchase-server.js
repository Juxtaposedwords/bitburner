/** @param {import("../../..").NS } ns */

// Buys a server of the specified RAM size.

function isPowerOfTwo(x) {
	return (Math.log(x)/Math.log(2)) % 1 === 0
}

export async function main(ns) {
	// When you run this script, specify the target on the command line.
	const ram = ns.args[0];

	if (ram == undefined) {
		ns.tprint("WARN: Usage: run purchaseServer.js <ram>")
		return;
	}

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