import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
  ns.tprint("Starting recursive network scan with path tracing...");
  
  const dirPath = "/data/servers/";

  interface ServerMetadata {
    hostname: string;
    organization: string;
    ip: string;
    pathFromHome: string;
    securityLevel: number;
    minSecurityLevel: number;
    hacked: boolean;
    backdoorInstalled: boolean;
    purchasedByPlayer: boolean;
    maxRam: number;
    cpuCores: number;
    hacking: {
      requirements: {
        level?: number;
        ports?: number;
      };
      ports: {
        ssh: boolean;
        ftp: boolean;
        smtp: boolean;
        http: boolean;
        sql: boolean;
      };
    };
    moneyAvailable?: number;
    maxMoney?: number;
  }

  // --- Recursive Network Discovery (BFS) with Path Tracking ---
  const visited: Set<string> = new Set(["home"]);
  const queue: { hostname: string; path: string }[] = [{ hostname: "home", path: "home" }];
  const serverPaths: Map<string, string> = new Map([["home", "home"]]);

  while (queue.length > 0) {
    const currentObj = queue.shift()!;
    const currentHost = currentObj.hostname;
    const currentPath = currentObj.path;

    const neighbors = ns.scan(currentHost);
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        const newPath = `${currentPath} -> ${neighbor}`;
        serverPaths.set(neighbor, newPath);
        queue.push({ hostname: neighbor, path: newPath });
      }
    }
  }

  const allServers = Array.from(visited);
  ns.tprint(`Discovered ${allServers.length} total servers on the network.`);

  // --- Process and Save Metadata for Every Discovered Server ---
  for (const host of allServers) {
    const serverInfo = ns.getServer(host);
    const pathFromHome = serverPaths.get(host) ?? host;

    const hostData: ServerMetadata = {
      hostname: host,
      organization: serverInfo.organizationName ?? "",
      ip: serverInfo.ip ?? "",
      pathFromHome: pathFromHome,
      securityLevel: serverInfo.hackDifficulty ?? 0,
      minSecurityLevel: serverInfo.minDifficulty ?? 0,
      hacked: serverInfo.hasAdminRights ?? false,
      backdoorInstalled: serverInfo.backdoorInstalled ?? false,
      purchasedByPlayer: serverInfo.purchasedByPlayer ?? false,
      maxRam: serverInfo.maxRam ?? 0,
      cpuCores: serverInfo.cpuCores ?? 1,
      hacking: {
        requirements: {
          level: serverInfo.requiredHackingSkill,
          ports: serverInfo.numOpenPortsRequired,
        },
        ports: {
          ssh: serverInfo.sshPortOpen,
          ftp: serverInfo.ftpPortOpen,
          smtp: serverInfo.smtpPortOpen,
          http: serverInfo.httpPortOpen,
          sql: serverInfo.sqlPortOpen,
        },
      },
      moneyAvailable: ns.getServerMoneyAvailable(host),
      maxMoney: serverInfo.moneyMax,
    };

    const filePath = `${dirPath}${host}.json`;
    ns.write(filePath, JSON.stringify(hostData, null, 2), "w");
  }

  ns.tprint("Recursive scan and metadata export with paths complete.");
}