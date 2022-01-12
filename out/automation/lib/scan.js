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

export function servers(ns) {
  return scan(ns, true)
}

export function allServers(ns) {
  return scan(ns, false)
}

export async function path(ns, source, destination) {
  const path = [];
  if (await dfs(ns, path, source, destination)) {
    return []
  }
  return path;
}

export async function dfs(ns, path, fromS, dest) {
  if (path.includes(fromS)) {
    return false;
  }
  path.push(fromS)
  const neighbors = ns.scan(fromS);
  if (neighbors.includes(dest)) {
    path.push(dest)
    return true;
  }
  // visit each neighbor and search from there.
  for (let fromN of neighbors) {
    if (await dfs(ns, path, fromN, dest)) {
      return true
    }
    await ns.sleep(10);
  }
  path.pop();
  return false;
}