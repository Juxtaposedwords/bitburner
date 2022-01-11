/** @param {import("../../..").NS } ns */

export async function main(ns) {
    const data = ns.flags([
		["server", ""], // sever to remove files from
	]);
    const server=data["server"];

    for (let file of ns.ls(server).filter(function (name) {
        return !(name.endsWith(".cct")||name.endsWith(".exe"))
    })){
        ns.tprintf("Deleting %s",file)
        ns.rm(file)
    }
}