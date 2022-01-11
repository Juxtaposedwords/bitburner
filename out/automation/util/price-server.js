/** @param {import("../../..").NS } ns */

export async function main(ns) {
	const ram = ns.args[0];
	if (!isPowerOfTwo(ram)) {
		ns.tprint(`WARN: ram must be a power of two.`);
		return;
	}
	ns.tprint(`Server with ${ram} ram costs ${ns.getPurchasedServerCost(ram)}`);
}

function isPowerOfTwo(x) {
	return (Math.log(x)/Math.log(2)) % 1 === 0
}