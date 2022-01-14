// @ts-ignore
import { path } from "/automation/lib/scan.js"
// @ts-ignore
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
  const hops = await path(ns,ns.getHostname(), destination)
  if (hops.length > 0) {
    run( "  connect " + hops.join("; connect "))
  }    
}
export function autocomplete(data, args) {
  return [...data.servers]; // This script autocompletes the list of servers.
  
}
