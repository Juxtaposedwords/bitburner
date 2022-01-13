// @ts-ignore
import { root } from  "/automation/lib/root.js"
// @ts-ignore
import { scan } from "/automation/lib/scan.js"

/** @param {import("../../..").NS } ns */
export async function main(ns) {
    for ( let server of scan(ns)){
        root(ns, server,true)
    }
}