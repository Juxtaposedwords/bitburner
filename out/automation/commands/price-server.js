/** @param {import("../../..").NS } ns */

export async function main(ns) {
	const ram = Number(ns.args[0]);
	if (ns.args[0] == undefined || !isPowerOfTwo(ram)) {
		ns.tprint(`WARN: ram must be a power of two.`);
		return;
	}
	ns.tprint(`Server with ${ram} ram costs ${ns.getPurchasedServerCost(ram)}`);
}

function isPowerOfTwo(x) {
	return (Math.log(x) / Math.log(2)) % 1 === 0
}


export function autocomplete(data, args) {
	return [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144]; // autocomplete powers of 2 for when the game goes CRAY
}