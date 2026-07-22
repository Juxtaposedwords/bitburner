import { NS, Server } from "@ns";
import { PORTS } from "functional/types/ports";
import { Action } from "functional/types/messages";
import { ServerMetadata } from "functional/types/serverMetadata";
import { createLogger, LOG_LEVEL } from "tools/logs";

// --- PURE FUNCTIONS ---
function toServerMetadata(hostname: string, pathFromHome: string, serverInfo: Server, moneyAvailable: number): ServerMetadata {
  return {
    hostname,
    organization: serverInfo.organizationName ?? "",
    ip: serverInfo.ip ?? "",
    pathFromHome,
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
        ssh: serverInfo.sshPortOpen ?? false,
        ftp: serverInfo.ftpPortOpen ?? false,
        smtp: serverInfo.smtpPortOpen ?? false,
        http: serverInfo.httpPortOpen ?? false,
        sql: serverInfo.sqlPortOpen ?? false,
      },
    },
    moneyAvailable,
    maxMoney: serverInfo.moneyMax,
  };
}

function mapNetwork(ns: NS, startNode: string = "home", onDiscover?: (node: string) => void): Map<string, string> {
  const visited = new Set<string>([startNode]);
  const queue = [{ hostname: startNode, path: startNode }];
  const paths = new Map<string, string>([[startNode, startNode]]);

  while (queue.length > 0) {
    const { hostname: currentHost, path: currentPath } = queue.shift()!;
    for (const neighbor of ns.scan(currentHost)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        
        if (onDiscover) onDiscover(neighbor);
        
        const newPath = `${currentPath} -> ${neighbor}`;
        paths.set(neighbor, newPath);
        queue.push({ hostname: neighbor, path: newPath });
      }
    }
  }
  return paths;
}

// --- MAIN EVENT LOOP ---
export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  
  const log = createLogger(ns, "Crawler", LOG_LEVEL.DEBUG);
  
  log.info("=== Starting Functional Network Crawler ===");

  const portId = PORTS.SERVER_METADATA;
  log.info(`[Phase 1] Mapping network topology...`);
  
  const networkTopology = mapNetwork(ns, "home", (node) => {
    log.debug(`[Found] ${node}`);
  });
  
  log.info(`[Phase 1] Complete. Discovered ${networkTopology.size} reachable nodes.`);
  log.info(`[Phase 2] Gathering state...`);

  const batchPayload: ServerMetadata[] = [];

  for (const [host, path] of networkTopology.entries()) {
    const rawServerInfo = ns.getServer(host);
    const moneyAvailable = ns.getServerMoneyAvailable(host);
    
    const metadata = toServerMetadata(host, path, rawServerInfo, moneyAvailable);
    batchPayload.push(metadata);
    
    const money = metadata.moneyAvailable ?? 0;
    const moneyStr = Math.round(money).toLocaleString();
    const hackStr = metadata.hacked ? "ROOTED" : "LOCKED";
    
    log.debug(`[Scanned] ${host.padEnd(18)} | ${hackStr} | Sec: ${metadata.securityLevel.toFixed(1).padEnd(5)} | Money: $${moneyStr}`);
  }

  log.info(`[Phase 3] Broadcasting batch payload to Port ${portId}...`);
  
  const action: Action = { type: "METADATA_BATCH_UPDATE", payload: batchPayload };
  const success = ns.tryWritePort(portId, JSON.stringify(action));

  if (!success) {
    log.error(`Port ${portId} queue is full! Make sure supervisor.js is running.`);
  } else {
    log.info(`Batch payload delivered successfully.`);
  }

  ns.tprint(`Crawler finished instantly. Sent ${batchPayload.length} servers in 1 batch to Port ${portId}.`);
}