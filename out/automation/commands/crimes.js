
const crimes = [
    "Shoplift",
    "Rob Store",
    "Mug Someone",
    "Larceny",
    "Dead Drugs",
    "Bond Forgery",
    "Traffick Illegal Arms",
    "Homicide",
    "Grand Theft Auto",
    "Kidnap and Ransom",
    "Assassinate",
    "Heist"
]
const lockFile = "/data/crime.txt"

/** @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["crime", ""],
        ["list", false],
    ])
    if (flags.list) {

        ns.tprintf(`Karma: ${ns.nFormat(ns.heart.break(),"0.00")}.   All stats are listed in xp - weighted success rate`)
        let title =`${`Crime`.padEnd(21," ")}    Money     Win %%  Time(s)   Karma         Str`
        title += ` ${`Def`.padStart(13," ")}`
        title += ` ${`Dex`.padStart(13," ")}`
        title += ` ${`Agi`.padStart(13," ")}`
        title += ` ${`Cha`.padStart(13," ")}`

        ns.tprintf(title)
        for (const crime of crimes) {
            const stats = ns.getCrimeStats(crime)
            let output = `${crime.padEnd(23," ")}  `
            output +=`${`${ns.nFormat(stats.money, "$0.0a")}`.padEnd(10," ")}`
            output += `${`${Math.floor(ns.getCrimeChance(crime)*100)}`.padEnd(5, " ")}  `
            output += `${`${(stats.time/1000)}`.padEnd(3," ")}       `
            output += `${`${-1*stats.karma}`.padEnd(5, " ")}   `
            output += `${`${stats.strength_exp}`.padStart(4, " ")} - ${`${stats.strength_success_weight}`.padStart(4, " ")}   `
            output += `${`${stats.defense_exp}`.padStart(4, " ")} - ${`${stats.defense_success_weight}`.padStart(4, " ")}   `
            output += `${`${stats.dexterity_exp}`.padStart(4, " ")} - ${`${stats.dexterity_success_weight}`.padStart(4, " ")}   `
            output += `${`${stats.agility_exp}`.padStart(4, " ")} - ${`${stats.agility_success_weight}`.padStart(4, " ")}   `
            output += `${`${stats.charisma_exp}`.padStart(4, " ")} - ${`${stats.charisma_success_weight}`.padStart(4, " ")}   `
            ns.tprintf(output)
        }
        return
    }
    const crime = flags.crime.replace('_', ' ')
    if (!crimes.includes(crime)) {
        ns.tprintf(`ERROR: "${crime}" is not include in crimeTime list`)
        return
    }
    if (ns.fileExists(lockFile)){
        ns.rm(lockFile,"home")
    }
    let started = Date.now()
    while (true) {
                await ns.commitCrime(crime)
        started = Date.now()
        while (ns.isBusy()){
            await ns.sleep(100)
        }
        // Without this check, crimes will just your screen and you'll have to kill all scripts.
        if ((Date.now()-started) <ns.getCrimeStats(crime).time-300){
            return
        }
    }
}

export function autocomplete(data, args) {
    data.flags([
        ["crime", ""],
        ["list", false],
    ]);

    const prompts = crimes.map(entry => entry.replace(" ", "_"))
    const options = {
        crime: prompts,
    };
    for (let arg of args.slice(-2)) {
        if (arg.startsWith("--")) {
            return options[arg.slice(2)] || [];
        }
    }
    return [];
}