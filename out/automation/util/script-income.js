/** @param {import("../../..").NS } ns */

// Report the income for each hack script running on home.
export async function main(ns) {
    const result = []
    const script = "/automation/util/hack.js"
    ns.ps("home")
        .filter((s) => s.filename==script)
        .forEach(s => result.push([s.args, ns.getScriptIncome(s.filename, "home", s.args)])
    );
    ns.tprint(result.join("\n"));
}