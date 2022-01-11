

/**
 * TODO(juxtaposedwords): find a way to make the need for 'await'  not necesasry when calling
 * TODO(juxtaposedwords): Add logging levels
 * TODO(juxtaposedwords): Add bg function which copies over file after write to home machine for central logging.
 * TODO(juxtaposedwords): Add log truncation at 1000 lines.
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
    const port = ns.getPortHandle(2);
    await ns.disableLog('ALL')
    while (true) {
        if (port.empty()) {
            await ns.sleep(1000);
            continue;
        }
        let v = port.read();

        let entry = JSON.parse(v);

        const rawFile = `/logs/raw/${ns.getHostname()}.txt`;
        if (ns.fileExists(rawFile)) {
            await ns.write(rawFile, v+"\n", "a")
        } else {
            await ns.write(rawFile, v+"\n", "w")
        }
        const outputFile = `/logs/${ns.getHostname()}/${entry.program}.txt`
        let line = `${entry.datetime} ${entry.program} : ${entry.message}\n`

        if (ns.fileExists(outputFile)) {
            await ns.write(outputFile, line, "a")
        } else {
            await ns.write(outputFile, line, "w")

        }
    }
}