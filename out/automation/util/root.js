
import { root } from  "/automation/lib/root.js"

/** @param {import("../../..").NS } ns */
export async function main(ns) {

    for ( let server of ns.scan()){
        root(ns, server)
    }
}