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

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["dry_run", true],
    ])
    var count =0;
    for (const server of servers(ns, false).sort()) {
        for (const contract of ns.ls(server).filter(function (name) {
            return name.endsWith("cct")
        })) {
            solveContract(ns, server, contract, 1, flags.dry_run)
            count++;
        }
    }
    if (count==0){
        ns.tprint("INFO: No contracts were found.")
    }
}
function solveContract(ns, host, filename, logLevel = 0, dryRun = false) {
    const type = ns.codingcontract.getContractType(filename, host);
    const desc = ns.codingcontract.getDescription(filename, host);
    const input = ns.codingcontract.getData(filename, host);
    let output = [
        ``,
        `${host.padEnd(15, ' ')} ${filename.padEnd(25, ' ')} ${type}`,
        `input:    ${input}`];
    const promptFunction = {
        "Algorithmic Stock Trader I": oneTransaction,
        "Algorithmic Stock Trader II": unlimitedTransactions,
        "Algorithmic Stock Trader III": twoTransactions, 
        "Algorithmic Stock Trader IV": kTransactions,
        "Array Jumping Game": jumpable,
        "Find All Valid Math Expression": allMathExpressions,
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
    if (!promptFunction[type]) {
        ns.tprintf(`No PromptFunction found for type ${type}`)
        return
    }
    const answer = promptFunction[type](ns, input)
    output.push(`solution: ${answer}`)
    let reward = "";
    if (!dryRun) {
        reward = ns.codingcontract.attempt(answer, filename, host, { 'returnReward': true });
    }
    output.push(`reward:   ${reward}`)
    let succint = `${host.padEnd(15, ' ')} ${filename.padEnd(25, ' ')}`
    ns.tprint(output.join("\n"))
    if (reward) {
        succint  += ` Reward: ${reward}`
        output.push(reward)
    } else {
        succint += ` FAILED (Type: ${type})`
        output.push(`result:  FAILED`)
    }
    if (logLevel = 0){
        ns.tprint(succint)
    } else if (logLevel = 1) {
        ns.tprint(output.join("\n"))
    }
}