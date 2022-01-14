// @ts-ignore
import { servers } from "/automation/lib/scan.js";

/**
 * Prints out all non .js files on all non-host servers.
 *  Servers and file are sorted alphabetically.
 * 
 *  @param {import("../../..").NS } ns */
export async function main(ns) {

    const data = ns.flags([
        ['extension', ''],
        ['exclude_extension', 'js'],
    ]);
    if (data['extension'] == data['exclude_extension']) {
        ns.tprintf("ERROR: cannot match and exclude with the same extension")
        return
    }
    for (const server of servers(ns, false).sort()) {
        const files = ns.ls(server).filter(function (name) {
            if (data['extension'] != '' && name.endsWith(data['extension'])) {
                return true
            } else if (data['extension'] != '') {
                return false
            }
            return !(name.endsWith(data['exclude_extension']))
        })
        if ((files.length == 0) || (server == "home")) {
            continue
        }
        ns.tprintf("%s", server)
        for (const file of files.sort()) {
            ns.tprintf("  %s", file)
        }
    }
}

export function autocomplete(data, args) {
    data.flags([
        ['extension', ''],
        ['exclude_extension', 'js'],
    ]);
    return ["cct", "js", "lit", "txt"]; // whether to use open ports or not

}