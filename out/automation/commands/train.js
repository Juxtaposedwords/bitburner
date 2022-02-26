const modes = ["combat", "all"]

/** @param {import("../../..").NS } ns */
export async function main(ns) {
    let flags = ns.flags([
        ["mode", ""],
        ["target",0]
    ])

    if (flags.mode ==""){
        flags.mode = "all"
    }

    if (!modes.includes(flags.mode)) {
        ns.tprintf(`INFO: Invalid mode selected. "${flags.mode}" is not one of ${modes.join(", ")}`)
    }
    const gym = function(attribute){
        ns.gymWorkout("powerhouse gym",attribute,true)
    }
    const uni = function(attribute){
        if (attribute == "hacking"){
            ns.universityCourse("Rothman University", "Algorithms", true)
        } else if (attribute =="charisma"){
            ns.universityCourse("Rothman University", "Leadership", true)
        } else {
            ns.tprintf(`ERROR: invalid attribute sent to uni.`)
        }
    }
    let stats = {
        "hacking": uni,
        "strength" : gym,
        "defense": gym,
        "dexterity": gym,
        "agility": gym,
        "charisma": uni,

    }
    const combat = ["strength", "defense", "dexterity", "agility"]
    if (flags.mode == "combat"){
        stats = stats.filter(name=>combat.includes(name))
    }

    const player = ns.getPlayer()

    // our strings are hard coded for Sector-12
    try { ns.travelToCity("Sector-12") } catch { }


    for (const stat in stats) {
        if (ns.getPlayer()[stat] < flags.target) {
            stats[stat](stat)
        }
        while (ns.getPlayer()[stat] < flags.target) {
            await ns.sleep( 500)
        }
        ns.stopAction()
    }
}


export function autocomplete(data, args) {
    data.flags([
        ["mode", ""],
        ["target",0],
    ]);

    const options = {
        mode: modes,
    };
    for (let arg of args.slice(-2)) {
        if (arg.startsWith("--")) {
            return options[arg.slice(2)] || [];
        }
    }
    return [];
}