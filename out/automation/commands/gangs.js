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
                    exp: member.hack_exp,
                    task: "Train Hacking",
                    equipment: ["NUKE Rootkit", "Soulstealer Rootkit", "Demon Rootkit", "Hmap Node", "Jack The Ripper"],
                },
                {
                    name: "str",
                    mult: member.str_asc_mult,
                    asc_mult: member.str_asc_mult,
                    exp: member.str_exp,
                    task: "Train Combat",
                    equipment: ["Baseball bat", "Katana", "Glock 18C", "p90c", "Steyr AUG", "Ak-47", "M15A10 Assault Rifle", "AWM Sniper Rifle"],
                },
                {
                    name: "def",
                    mult: member.def_mult,
                    asc_mult: member.def_asc_mult,
                    exp: member.def_exp,
                    task: "Train Combat",
                    equipment: ["Baseball bat", "Katana", "Glock 18C", "p90c", "Steyr AUG", "Ak-47", "M15A10 Assault Rifle","Bulletproof Vest","Full Body Armor","Liquid Body Armor","Graphene Plating Armor"],
                },
                {
                    name: "dex",
                    mult: member.dex_mult,
                    asc_mult: member.dex_asc_mult,
                    exp: member.dex_exp,
                    task: "Train Combat",
                    equipment: ["Katana", "Glock 18C", "Ak-47", "AWM Sniper Rifle"],
                },
                {
                    name: "agi",
                    mult: member.agi_mult,
                    asc_mult: member.agi_asc_mult,
                    exp: member.agi_exp,
                    task: "Train Combat",
                    equipment: ["Glock 18C",  "AWM Sniper Rifle","Liquid Body Armor","Ford Flex V20","ATX1070 Superbike", "Mercedes-Benz S9001", "White Ferrari"],
                },
                {
                    name: "cha",
                    mult: member.cha_mult,
                    asc_mult: member.cha_asc_mult,
                    exp: member.cha_exp,
                    task: "Train Charisma",
                    equipment: ["Ford Flex V20","ATX1070 Superbike", "Mercedes-Benz S9001", "White Ferrari"],
                },
            ]
            ns.gang.ascendMember(name)
            let lowest = mults.sort((left, right) => left.asc_mult - right.asc_mult)[0]
            ns.gang.setMemberTask(name, lowest.task)
            for (const equipment of lowest.equipment){
                ns.gang.purchaseEquipment(name,equipment)
            }

        }
        await ns.asleep(40 * 60 * 1000)
    }
}
/*
export function autocomplete(data, args) {
    return [...data.servers]; 
}
*/