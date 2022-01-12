// @ts-ignore
import { servers } from "/automation/lib/scan.js";

/**
 * Prints out all non .js files on all non-host servers.
 *  Servers and file are sorted alphabetically.
 * 
 *  @param {import("../../..").NS } ns */
export async function main(ns) {

    for (let server of servers(ns, false).sort()) {

        let files = ns.ls(server).filter(function (name) {
            return !(name.endsWith(".js"))
        })
        if ((files.length == 0) || (server == "home")) {
            continue
        }
        ns.tprintf("%s", server)
        for (let file of files.sort()) {
            ns.tprintf("  %s", file)
        }
    }
}