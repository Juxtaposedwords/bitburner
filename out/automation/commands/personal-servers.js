
// @ts-ignore
import { jsonLog } from "/automation/lib/log.js"

// @ts-ignore
import { scan } from "/automation/lib/scan.js"

const modes = ["buy", "sell", "setup", "fill", "stop"]

/** Runs continuously until it has bought all servers you can buy
 *  (it will wait until you can afford them).  Each purchased server
 * will have purchased-server-hack.js installed on it.
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["mode", ""], // see modes
        ["server_pow2", 0],
        ["create_skip_setup", false],
    ])
    if (flags.mode == "buy" && (flags.server_pow2 < 1 || flags.server_pow2 > 20)) {
        ns.tprintf(`ERROR:  --create must be used with a --server_pow2 between 1 and 20 inclusive. ${flags.server_pow2} was used`)
        return
    }
    if (!modes.includes(flags.mode)) {
        ns.tprintf(`ERROR: --mode must be one of: ${modes.join(", ")}`)
        return
    }
    const log = async function (message) {
        await jsonLog(ns,
            "grow.js", message, { "mode": flags.mode, })
    }
    if (flags.mode == "buy") { await buy(ns, flags.server_pow2, flags.create_skip_setup) }
    if (flags.mode == "setup") { await setup(ns) }
    if (flags.mode == "fill" || flags.mode == "buy") { await fill(ns) }
    if (flags.mode == "sell") { await sell(ns) }
    if (flags.mode == "stop") { await stop(ns) }
}
async function buy(ns, pow2, create_skip_setup) {
    const ram = Math.pow(2, Number(pow2));
    // Suffix for server names.
    let i = ns.getPurchasedServers().length;
    while (i < 25) {
        await ns.sleep(500);
        // Check if we have enough money to purchase a server.  If we don't,
        // this script will wait until we do.  This is useful in the early
        // game when you don't have enough money to buy up to the limit.
        if (ns.getServerMoneyAvailable("home") < ns.getPurchasedServerCost(ram)) {
            //	ns.tprintf(`sleeping as server Money: ${ns.getServerMoneyAvailable("home")} < ${ns.getPurchasedServerCost(ram)}`)
            continue;
        }
        const hostname = ns.purchaseServer("pserv-" + i, ram);
        if (hostname == "") {
            ns.tprint("ERROR: Failed to purchase server " + hostname)
            return;
        }
        await ns.scp([
            "/automation/util/grow-hack-weak.js",
            "/automation/util/weaken.js",
            "/automation/util/grow.js",
            "/automation/util/hack.js",
            "/automation/lib/log.js",
        ], "home", hostname)
        if (!create_skip_setup) {
            await setup(ns, hostname)
        }
        i++;

    }
    ns.tprintf("INFO: Congratulations, purchased server limit reached.")
}
/**  @param {import("../../..").NS } ns */
async function setup(ns, hostname = "none") {
    let targets = scan(ns).filter(name => {
        const server = ns.getServer(name);
        return (server.moneyMax > 0 && name != "home")
    })
    let purchasedServers = ns.getPurchasedServers();
    if (!hostname.match("none")) {
        purchasedServers = [hostname]
    }
    for (const server of purchasedServers) {
        ns.killall(server)
        for (const target of targets) {
            const host = ns.getServer()
            const startHack = "/automation/util/start-hack.js"
            // wait until we have free space for the ram
            let count = 50 
            while ((host.maxRam - host.ramUsed) < ns.getScriptRam(startHack)) {
                count = count * 2
                await ns.sleep(count)
            }
            ns.exec("/automation/util/start-hack.js", "home", 1, ...["--target", target, "--server", server])
        }
    }
}
/**  @param {import("../../..").NS } ns */
async function fill(ns) {
    for (const hostname of ns.getPurchasedServers()) {
        const server = ns.getServer(hostname)
        const script = "/automation/util/grow-hack-weak.js"
        const hackRam = ns.getScriptRam(script)
        const hackThreads = Math.floor((server.maxRam - server.ramUsed) / hackRam)
        if (hackThreads < 0) {
            continue
        }
        let count = 50 
        while ((server.maxRam - server.ramUsed) < ns.getScriptRam(script)) {
            count = count * 2
            await ns.sleep(count)
        }
        await ns.exec(script, hostname, hackThreads, ...["clarkinc", "level"])
    }
}

/**  @param {import("../../..").NS } ns */
async function sell(ns) {
    for (const server of ns.getPurchasedServers()) {
        ns.killall(server)
        ns.deleteServer(server)
    }
    ns.tprintf("INFO: All personal servers sold.")

}
/**  @param {import("../../..").NS } ns */
async function stop(ns) {
    for (const server of ns.getPurchasedServers()) {
        ns.killall(server)
    }
}

export function autocomplete(data, args) {
    data.flags([
        ["mode", ""], // see modes
        ["server_pow2", 0],
        ["create_skip_setup", false],
    ])
    const options = {
        'mode': modes,
    }

    for (let arg of args.slice(-2)) {
        if (arg.startsWith('--')) {
            return options[arg.slice(2)] || []
        }
    }
    return []
}