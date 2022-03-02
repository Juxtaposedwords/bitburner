/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["server", null],
        ["target", null],
    ])

    while (true) {

        for (const name of ns.gang.getMemberNames()) {
            const member = ns.gang.getMemberInformation(name)
            const mults = [
                {
                    name: "hack",
                    mult: member.hack_mult,
                    asc_mult: member.hack_asc_mult,
                    exp : member.hack_exp,
                },
                {
                    name: "str",
                    mult: member.str_asc_mult,
                    asc_mult: member.str_asc_mult,
                    exp : member.str_exp,
                },
                {
                    name: "def",
                    mult: member.def_mult,
                    asc_mult: member.def_asc_mult,
                    exp : member.def_exp,
                },
                {
                    name: "dex",
                    mult: member.dex_mult,
                    asc_mult: member.dex_asc_mult,
                    exp : member.dex_exp
                },
                {
                    name: "agi",
                    mult: member.agi_mult,
                    asc_mult: member.agi_asc_mult,
                    exp : member.agi_exp,
                },
                {
                    name: "cha",
                    mult: member.cha_mult,
                    asc_mult: member.cha_asc_mult,
                    exp : member.cha_exp,
                },
            ]
            for (const stat of mults) {
                //ns.tprintf(` ${stat.name} ${stat.mult} ${stat.asc_mult}`)
                if (stat.exp>500*stat.asc_mult) {
                    ns.gang.ascendMember(name)
                }

            }
        }
        await ns.asleep(10*60*1000)
    }
}
/*
export function autocomplete(data, args) {
    return [...data.servers]; 
}
*/