// @ts-ignore
import { jumpable } from "/automation/contracts/jump.js"
// @ts-ignore
import { triangle, grid, gridWithObstacles } from "/automation/contracts/path.js"
// @ts-ignore
import { largestPrimeFactor } from "/automation/contracts/prime.js"
// @ts-ignore
import { sanitize } from "/automation/contracts/parentheses.js"
// @ts-ignore
import { spiralize } from "/automation/contracts/matrix.js"
// @ts-ignore
import { merge } from "/automation/contracts/intervals.js"
// @ts-ignore
import { generate } from "/automation/contracts/ip-addresses.js"
// @ts-ignore
import { totalWayToSum, subarrayWithMaxSum } from "/automation/contracts/sum.js"
// @ts-ignore
import { oneTransaction, unlimitedTransactions, twoTransactions, kTransactions } from "/automation/contracts/stock-trader.js"
// @ts-ignore
import { allMathExpressions } from "/automation/contracts/expressions.js"


// @ts-ignore
import { servers } from "/automation/lib/scan.js";

/**
 *  *  @param {import("../../..").NS } ns */
export async function main(ns) {
    const flags = ns.flags([
        ["verbosity", 1],
        ["dry_run", false]
    ])
    var count = 0;
    for (const server of servers(ns, false).sort()) {
        for (const contract of ns.ls(server).filter(function (name) {
            return name.endsWith("cct")
        })) {
            solveContract(ns, server, contract, flags.verbosity, flags.dry_run);
            count++;
        }
    }
    if (count == 0 && flags.verbosity > 0) {
        ns.tprint("INFO: No contracts were found.")
    }
}

/**  
 * *  @param {import("../../..").NS } ns */
function solveContract(ns, host, filename, logLevel = 0, dryRun = false) {
    const type = ns.codingcontract.getContractType(filename, host);
    const desc = ns.codingcontract.getDescription(filename, host);
    const input = ns.codingcontract.getData(filename, host);
    let output = [
        `INFO:`,
        `${host.padEnd(15, ' ')} ${filename.padEnd(30, ' ')} ${type}`,
        `input:    ${input}`];
    const promptFunction = {
        "Algorithmic Stock Trader I": oneTransaction,
        "Algorithmic Stock Trader II": unlimitedTransactions,
        "Algorithmic Stock Trader III": twoTransactions,
        "Algorithmic Stock Trader IV": kTransactions,
        "Array Jumping Game": jumpable,
        "Find All Valid Math Expressions": allMathExpressions, // slow, but _eventually works
        "Find Largest Prime Factor": largestPrimeFactor,
        "Generate IP Addresses": generate,
        "Merge Overlapping Intervals": merge,
        "Minimum Path Sum in a Triangle": triangle,
        "Sanitize Parentheses in Expression": sanitize,
        "Spiralize Matrix": spiralize,
        "Subarray with Maximum Sum": subarrayWithMaxSum,
        "Total Ways to Sum": totalWayToSum,
        "Unique Paths in a Grid I": grid,
        "Unique Paths in a Grid II": gridWithObstacles,
    }
    const answer = promptFunction[type](ns, input)
    output.push(`solution: ${answer}`)
    let reward = "";
    if (!dryRun) {
        reward = ns.codingcontract.attempt(answer, filename, host, { 'returnReward': true });
    }
    let succint = `INFO: ${host.padEnd(15, ' ')} ${filename.padEnd(30, ' ')}`
    if (reward || dryRun) {
        succint += ` Reward:   ${reward}`
        output.push(reward)
    } else {
        succint += ` FAILED (Type: ${type})`
        output[0] = `ERROR:`
        output.push(`result:   FAILED`)
    }
    if (logLevel === 1) {
        ns.tprintf(succint)
    } else if (logLevel === 2) {
        ns.tprintf(output.join("\n"))
    }
}

export function autocomplete(data, args) {
    data.flags([
        ["verbosity", 1],
        ["dry_run", false],
    ])
    const options = {
        'verbosity': [0, 1, 2],
    }
    for (let arg of args.slice(-2)) {
        if (arg.startsWith('--')) {
            return options[arg.slice(2)] || []
        }
    }
    return []
}