
import { dfs } from "/automation/lib/scan.js"
import { run } from "/automation/lib/terminal.js"

/** @param {import("../../..").NS } ns */
export async function main(ns) {
  const destination = ns.args[0];
  const path = [];
  await dfs(ns, path, ns.getHostname(), destination);
  path.shift(); // get rid of "home"
  if (path.length > 0) {
    run(ns, "  connect " + path.join("; connect "))
  }
}
export function autocomplete(data, args) {
  return [...data.servers]; // This script autocompletes the list of servers.
}