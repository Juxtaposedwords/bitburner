/** reorg.js reorganizes a division so that the most intelligent
 *  personnel are all in Operations.
 * 
 * @param {import("../../..").NS } ns */

 export async function main(ns) {
    const div = ns.args.length > 0 ? String(ns.args[0]) : undefined
    if (div == undefined) {
        ns.tprint("WARN: Usage: reorg.js <division>")
    }
    const api = ns.corporation
    ns.tprint(`INFO: Revenue/second before swap, ${ns.nFormat(api.getCorporation().revenue, '0.00a')}`) 

    for (const city of api.getDivision(div).cities) {        
        const o = api.getOffice(div, city)
        const emp = o.employees.map(x => api.getEmployee(div, city, x))
        const ops = emp.filter(x => x.pos == "Operations").length
        const byInt = emp.sort((a, b) => b.int - a.int)
        const smart = byInt.slice(0, ops) // enough smart employees to fully staff Operations
        const dumb = byInt.slice(ops)     // everyone else
        const toSwapSmart = smart.filter(x => x.pos != "Operations") // smart employees that aren't in Operations already
        const toSwapDumb = dumb.filter(x => x.pos == "Operations")   // dumb employees that are in Operations already

        if (toSwapSmart.length != toSwapDumb.length) {
            ns.tprint(`ERROR: swap lists for ${city} are of unequal size (smart=${toSwapSmart.length}, dumb=${toSwapDumb.length}).`)
            return
        }
        if (toSwapSmart.length == 0) {
            ns.tprint(`WARN: nothing to swap in ${city}!`)
            continue
        }
        ns.tprint(`Swapping in ${city}...`)
        for (let i = 0; i < toSwapSmart.length; i++) {
            const s = toSwapSmart[i]
            const d = toSwapDumb[i]
            ns.tprint(`INFO: assigning ${d.name} to ${s.pos}`)
            await api.assignJob(div, city, d.name, s.pos)
            ns.tprint(`INFO: assigning ${s.name} to Operations`)
            await api.assignJob(div, city, s.name, "Operations")
        }
    }
    ns.tprint(`INFO: Revenue/second after swap, ${ns.nFormat(api.getCorporation().revenue, '0.00a')}`) 
}