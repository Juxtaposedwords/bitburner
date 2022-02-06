/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const instructions = [
        () => { return launch(ns, "/startup.js") },
        () => { return launch(ns, "/automation/util/bg/upgrade-home.js") },
        () => { return launch(ns, "/automation/util/bg/bg.js", ["/automation/commands/contract-auto-solver.js", 1000*60*10, 1, "--verbosity", 0]) },
        () => { return buyPrograms(ns) },
        () => { return launch(ns, "/startup.js") },

    ]
    while (instructions.length != 0) {
        await instructions[0]()
        instructions.shift()
        await ns.sleep(100)
    }

}
/**
 * 
 * Starts background jobs to buy programs. 
 *  @param {import("../../..").NS } ns */
async function buyPrograms(ns) {
    while (ns.getPlayer().money.valueOf() < 200000) {
        await ns.sleep(100)
    }
    ns.purchaseTor()
    var names = [
        "BruteSSH.exe",
        "FTPCrack.exe",
        "relaySMTP.exe",
        "HTTPWorm.exe",
        "SQLInject.exe"]
    const home = ns.getServer("home")
    const purchaseScript = "/automation/util/bg/purchase-program.js"

    for (const name of names) {
        await launch(ns, purchaseScript, ["--program", name])
    }
    return
}
/** @param {import("../../..").NS } ns */
async function contracts(ns) {


}
/** @param {import("../../..").NS } ns */
async function launch(ns, name, args = []) {
    const script = name
    const home = ns.getServer("home")
    var availRam = home.maxRam - home.ramUsed;
    const progRam = ns.getScriptRam(script, "home");
    let memCount = (availRam / progRam)
    while (memCount < 1) {
        await ns.sleep(1000 * 10)
        availRam = home.maxRam - home.ramUsed;
        memCount = (availRam / progRam)
    }
    ns.exec(script, "home", 1, ...args)
    await ns.sleep(5000) // wait 5 seconds, as we don't trust exec to quickly update.
}

export function autocomplete(data, args) {
    return
}