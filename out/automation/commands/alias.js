// @ts-ignore
import { run } from "/automation/lib/terminal.js"

/** 
 *  Alias creates an alias for each command in the command directory
 * 
 *  NOTE: this will unalias all previous command first.
 * 
 * 
 * @param {import("../../..").NS } ns */
export async function main(ns) {
    for (let script of ns.ls("home").filter(input => { return String(input).startsWith("/automation/commands/") })) {
        if (script.endsWith("alias.js")){
            continue
        }
        let commandName = script.split(".")[0].split("/").pop()
        run(`unalias "${commandName}"`)
        run(`alias ${commandName}="run ${script}"`)
    }
}