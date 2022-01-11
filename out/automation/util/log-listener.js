/**   
 * Listen to port 1 and logs all values received.
 *   Strings written out which begin and end with bracktes are assumed to be json objects.
 *   Json printing also prints to a single file with all json objects and to individual log files for each host.
 * 
 * @param {import("../../..").NS } ns */
export async function main(ns) {
    ns.disableLog('ALL')
    const h = ns.getPortHandle(1);
    while (true) {
        if (h.empty()) {
            await ns.sleep(100);
            continue;
        }
        let v = await ns.readPort(1);
        // Log any string objects.
        if (!(typeof v === 'string')) {
            ns.write('log.txt', v + '/n');
            continue
        }
        let input = v + "";
        if (input.startsWith("{") && input.endsWith("}")) {
            // Handle our pretty json printing.
            let entry = JSON.parse(input);
            // don't know what this is supposed to do, but it's unused.
            // let line = `${entry.date} ${entry.method}.js : target=${entry.target} start=${entry.} amount=${entry.amount}`
            await ns.write(`logs/${entry.host}.log`, v + '\n')
            await ns.write('logs/all.log', input + '\n')
        } else {
            // this is the current non-json behavior route.
            await ns.write('log.txt', v + '\n');
        }
    }
}