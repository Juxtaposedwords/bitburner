import { scan } from "./automation/lib/scan";

/**  init-purchased-server.js initializes a new purchased server.  It will
 *   find all possible targets that we are not currently hacking with a
 *   server we own (i.e. home and purchased servers), order them by required
 *   hacking level, and launch grow/hack/weaken scripts on the server until
 *   it has no more RAM available.
 * @param {import("../../..").NS } ns */
 export async function main(ns) {
	const flags = ns.flags([
		["server", null],  // the server that will run the scripts
        ["ignore_home", false] // don't look at home when checking what sites are being hacked
	]);	
	const usage = "WARN: Usage: init-purchased-server.js --server <server> --target <target>"
	if (flags.server == null)  {
		ns.tprint(usage)
		return;
	}
    const purch = ns.getPurchasedServers()
    if (!purch.includes(flags.server)) {
        ns.tprint("WARN:  init-purchased-server.js works only on purchased servers.")
    }

    let s = ns.getPurchasedServers()
    if (!flags.ignore_home) {
        s = ["home"].concat(s)
    }
    const h = hacking(ns, s)
    const targets = available(ns, h)

    if (targets.length == 0) {
        ns.tprint("INFO: All available servers are being hacked.")
        return
    }

    await cleanServer(ns, flags.server)

	const weakenThreads = 400
	const weakenRam = ns.getScriptRam("/automation/util/weaken.js");
	const growRam = ns.getScriptRam("/automation/util/grow.js");
	const hackRam = ns.getScriptRam("/automation/util/hack.js")
    const started = [];

    for (const target of targets) {
        const growThreads = Math.floor(ns.growthAnalyze(target, 4));
        const hackThreads = Math.floor(.25 / ns.hackAnalyze(target))
        const neededRam = (weakenRam * weakenThreads + growRam * growThreads + hackRam * hackThreads)
        const availRam = ns.getServerMaxRam(flags.server) - ns.getServerUsedRam(flags.server)
    
        if (neededRam > availRam) {
            ns.tprint(`INFO: skipping ${target}, ${ns.nFormat(neededRam, '0.0a')} RAM needed.`)
            continue
        }
        ns.exec("/automation/util/weaken.js", flags.server, weakenThreads, target);
        ns.exec("/automation/util/grow.js", flags.server, growThreads, target);
        ns.exec("/automation/util/hack.js", flags.server, hackThreads, target);
        started.push(target)
    }   

    if (started.length == 0) {
        ns.tprint(`INFO: Not enough RAM on ${flags.server} to hack any available servers.`)
        return
    }
    ns.tprint(`INFO: Started hacking ${started.length} servers: ${started.join(', ')}.`)
}

// cleanServer removes all .js files on the server.
async function cleanServer(ns, server) {
    ns.killall(server)
    for (const file of ns.ls(server).filter(n => n.endsWith('.js'))) {
        ns.rm(file, server)
    }
    await ns.scp([
        "/automation/util/weaken.js",
        "/automation/util/grow.js",
        "/automation/util/hack.js",
        "/automation/lib/log.js",
    ], "home", server)
}

// hacking returns an object containing the names of all targets of hack.js
function hacking(ns, servers) {
    const result = {}
    for (const s of servers) {
        for (const ps of ns.ps(s).filter(n => n.filename.endsWith("/hack.js"))) {
            result[ps.args[0]] = true
        }
    }
    return result  
}

// available returns the names of all servers that aren't currently being hacked
// and that we can hack, ordered by hacking level
function available(ns, hacking) {
    const result = [];
    const level = {};
    for (const s of scan(ns, true).filter(
            x => x != "home" && 
            hacking[x] != true && 
            ns.getServerMoneyAvailable(x) > 0 
            && ns.getServerRequiredHackingLevel(x) <= ns.getHackingLevel())) {
        result.push(s)
        level[s] = ns.getServerRequiredHackingLevel(s)
    }
    result.sort((a, b) => level[a] > level[b] ? 1 : -1)
    return result
}