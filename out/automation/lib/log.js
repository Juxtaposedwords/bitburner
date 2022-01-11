/** @param {import("../../..").NS } ns */

// log sends a structured status message to port 1.  Ex:
//
//   await log(ns, 'hack', 'some-server', 100000)
//
// will write "thisserver,hack,some-server,100k" to port 1.
export async function log(ns, method, target, amt) {
    const p = ns.getPortHandle(1);
    const msg = [
        new Date().toISOString(),
        ns.getHostname(),
        method,
        target,
        ns.nFormat(amt, '0.0a'),
    ].join(',');
    if (!await p.tryWrite(msg)) {
        ns.print('WARN: failed to write msg ${msg}')
    }
}

export async function jsonLog(ns, method, target, amt) {
    const p = ns.getPortHandle(1);
    JSON.stringify()
    const msg = JSON.stringify({
        "date": new Date().toISOString(),
        "host": ns.getHostname(),
        "method": method,
        "target": target,
        "amount": ns.nFormat(amt, '0.0a'),
    })
    if (!await p.tryWrite(msg)) {
        ns.print('WARN: failed to write msg ${msg}')
    }
}
