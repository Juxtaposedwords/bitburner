/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const data = ns.flags([
        ['extension', 'js'],
        ['server', ''], // server to remove files from
    ]);
    const server = data["server"];

    for (const file of ns.ls(server).filter(function (name) {
        return (name.endsWith("." + data["extension"]))
    })) {
        ns.tprintf("Deleting %s", file)
        ns.rm(file, server)
    }
}