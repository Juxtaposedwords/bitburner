import { path } from "/automation/lib/scan.js"
import { run } from "/automation/lib/terminal.js"


/**
* Connect to a server.
* @remarks
*  Ram Cost: 0.05 GB
*  
* Run the connect HOSTNAME command in the terminal.  Can connect to any machine.
*  
* @param {import("../../..").NS } ns 
*/
export async function main(ns) {
  const destination = ns.args[0];
  const serverPath = path(ns,ns.getHostname(), destination) 
  serverPath.shift(); // get rid of "home"
  if (serverPath.length > 0) {
    run(ns, "  connect " + serverPath.join("; connect "))
  } else {
    ns.tprintf("ERROR: Failed to find path to %s.",destination)
  }
}
export function autocomplete(data, args) {
  return [...data.servers]; // This script autocompletes the list of servers.
}
