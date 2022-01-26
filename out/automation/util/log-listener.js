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
    const flags = ns.flags([
		["port", 2], // Which port the listener should listen to.
	]);
    const port = ns.getPortHandle(flags.port);
    await ns.disableLog('ALL')
    while (true) {
        if (port.empty()) {
            await ns.sleep(1000);
            continue;
        }
        const v = port.read();

        const entry = JSON.parse(v);

        // Write the raw json log.
        const rawFile = `/logs/raw/${entry.host}.txt`;
        update(ns, rawFile, v + "\n")

        // Write out the structured log,
        const outputFile = `/logs/${entry.host}/${entry.program}.txt`
        const line = `${entry.datetime} ${entry.program} : ${entry.message}\n`
        update(ns, outputFile, line)
    }
}
// TODO add log file truncation
async function update(ns, fileName, line, destination) {
    await ns.write(fileName,line,ns.fileExists(fileName)? "a":"w")
}