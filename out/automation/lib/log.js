/** log sends a structured status message to port 1.  
 * Ex:
 *  await log(ns, 'hack', 'some-server', 100000)
 * 
 * will write "thisserver,hack,some-server,100k" to port 1.
 * @param {import("../../..").NS } ns */
export async function log(ns, method, target, amt) {
    const p = ns.getPortHandle(1);
    const msg = [
        new Date().toISOString(),
        ns.getHostname(),
        method,
        target,
        ns.nFormat(amt, '0.0a'),
    ].join(',');
    if (!await ns.tryWritePort(1,[msg])) {
        ns.print('WARN: failed to write msg ${msg}')
    }
}


/** @param {import("../../..").NS } ns */
export async function jsonLog(ns, program, message, rawJSON = {}) {
    const entry = JSON.stringify({
        ...{
            "message": message,
            "host": ns.getHostname(),
            "datetime": new Date().toISOString(),
            "program": program,
        },
        ...rawJSON,
    })
    if (!await ns.tryWritePort(2, [entry])) {
        ns.print('WARN: failed to write msg ${msg}')
    }
}
