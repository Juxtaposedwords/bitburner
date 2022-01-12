import { servers } from "../lib/scan";


/**
 * TODO(juxtaposedwords): find a way to make the need for 'await'  not necesasry when calling
 * TODO(juxtaposedwords): Add logging levels
 * TODO(juxtaposedwords): Add log file line truaction.
 * Json-logger creates a listener which listens to port 2 and writes everything received to a file asssociated with the logging services' name.
 *  Usage example:
 *      export async function main(ns) {
 *          await log(ns, "i'be been waiting.");
 *          await log(ns, "for the longest time.");
 *      }
 *  async function log(ns, message) { await jsonLog(ns, "MY_COMPLETLEY_REAL_PROGRAM_NAME", message)} 
 * 
 *  @param {import("../../..").NS } ns */
export async function main(ns) {
    const data = ns.flags([
		["port", 2], // Which port the listener should listen to.
        ["log-dest", "home"], // Which port the listener should listen to.
	]);
    const port = ns.getPortHandle(data["port"]);
    await ns.disableLog('ALL')
    while (true) {
        if (port.empty()) {
            await ns.sleep(1000);
            continue;
        }
        let v = port.read();

        let entry = JSON.parse(v);

        // Write the raw json log.
        const rawFile = `/logs/raw/${ns.getHostname()}.txt`;
        // we can't use a variable for the "a" in this context, as the letter a is not the flag append.
        update(ns, rawFile, v + "\n", data["log-dest"])

        // Write out the structured log,
        const outputFile = `/logs/${ns.getHostname()}/${entry.program}.txt`
        let line = `${entry.datetime} ${entry.program} : ${entry.message}\n`
        update(ns, outputFile, line, data["log-dest"])
    }
}

async function update(ns, fileName, line, destination) {
    if (ns.fileExists(fileName)) {
        await ns.write(fileName, line, "a")
    } else {
        await ns.write(fileName, line, "w")
    }
    ns.scp(fileName, ns.getHostname(), destination)

}