/** @param {import("../../..").NS } ns */

// Return a list of all reachable servers.  This will exclude
// purchased servers (if specified) and the server ".", but will
// include "home".
export function scan(ns, removePurchased = true) {
  const pservs = ns.getPurchasedServers();
  const nodes = new Set;
  function dfs(node) {
    if (node == ".") {
      return;
    }
    if (removePurchased && pservs.includes(node)) {
      return
    }
    nodes.add(node);
    for (const neighbor of ns.scan(node)) {
      if (!nodes.has(neighbor)) {
        dfs(neighbor);
      }
    }
  }
  dfs("home");
  return [...nodes]
}

export async function path(ns, source, dest) {
  let output = [];
  await dfs(ns, output, source, dest)
  output.shift() // Remove the source itself.
  return output

}
export function servers(ns) {
  return scan(ns, true)
}

export function allServers(ns) {
  return scan(ns, false)
}


export async function dfs(ns, output, fromS, dest) {
  if (output.includes(fromS)) {
    return false;
  }
  output.push(fromS)
  const neighbors = ns.scan(fromS);
  if (neighbors.includes(dest)) {
    output.push(dest)
    return true;
  }
  // visit each neighbor and search from there.
  for (let fromN of neighbors) {
    if (await dfs(ns, output, fromN, dest)) {
      return true
    }
    await ns.sleep(10);
  }
  output.pop();
  return false;
}