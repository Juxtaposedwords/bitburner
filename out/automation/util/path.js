/** @param {import("../../..").NS } ns */

import { dfs } from  "/automation/lib/scan.js"

export async function main(ns) {
    const toFind = ns.args[0];
    const command = (ns.args.length > 1 && ns.args[1] == "command")
    const path = [];
    if (await dfs(ns, path, "home", toFind)) {
      if (command) {
        path.shift(); // get rid of "home"
        ns.tprint("Connect to:")
        ns.tprint("  connect " + path.join("; connect ") )
        ns.tprint("Connect back:")
        path.pop()
        ns.tprint("  connect " + path.reverse().join("; connect ") + "; connect home")
        return
      }
      ns.tprint(path.join(" → "));
      return;
    }
    ns.tprint(`${toFind} not found.`);
  }
  
