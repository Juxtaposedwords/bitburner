
// @ts-ignore
import { dfs } from  "/automation/lib/scan.js"

/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const toFind = ns.args[0];
    const command = (ns.args.length > 1 && ns.args[1] == "command")
    const path = [];
    if (await dfs(ns, path, "home", toFind)) {
      if (command) {
        path.shift(); // get rid of "home"
        ns.tprint("  connect " + path.join("; connect ") )
        return
      }
      ns.tprint(path.join(" → "));
      return;
    }
    ns.tprint(`${toFind} not found.`);
  }

  export function autocomplete(data, args) {
    return [...data.servers]; // This script autocompletes the list of servers.
  }
