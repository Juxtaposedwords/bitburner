/* 
    purge-logs.js purges all of the logs on the home server.

 @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["raw_only", false]
    ])
    const prefix = flags.raw_only ? "/logs/raw" : "/logs"
    const files = ns.ls("home", prefix)
    for (const f of files) {
        ns.rm(f, "home")
    }
}