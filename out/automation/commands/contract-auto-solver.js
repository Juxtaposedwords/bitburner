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
    for (const server of servers(ns, false).sort()) {
        const contracts = ns.ls(server).filter(function (name) {
            return name.endsWith("cct")
        })
        for (const contract of ns.ls(server).filter(function (name) {
            return name.endsWith("cct")
        })) {
            solveContract(ns, server, contract, 1);
        }
    }
}
function solveContract(ns, host, filename, logLevel = 0) {
    const type = ns.codingcontract.getContractType(filename, host);
    const desc = ns.codingcontract.getDescription(filename, host);
    const title = ns.codingcontract.getData(filename, host);
    ns.tprint(host + " " + filename);
    ns.tprint(type);
    if (logLevel >= 1) {
        ns.tprint(`INFO: ${title}`);
    }
    if (logLevel>=2 ){
        ns.tprint(`INFO: ${desc}`)
    }
    const promptFunction = {
        "Algorithmic Stock Trader I": oneTransaction,
        "Algorithmic Stock Trader II": unlimitedTransactions,
        "Algorithmic Stock Trader III": twoTransactions, //broken
        "Algorithmic Stock Trader IV": kTransactions,
        "Array Jumping Game": jumpable,
        "Find All Valid Math Expression": allMathExpressions,
        "Find Largest Prime Factor": largestPrimeFactor,
        "Generate IP Addresses": generate,
        "Merge Overlapping Intervals": merge,
        "Minimum Path Sum in a Triangle": triangle, //broken
        "Sanitize Parentheses in Expression": sanitize, //broken
        "Spiralize Matrix": spiralize,
        "Subarray with Maximum Sum": subarrayWithMaxSum, //broken
        "Total Ways to Sum": totalWayToSum,
        "Unique Paths in a Grid I": grid, // verified
        "Unique Paths in a Grid II": gridWithObstacles,
    }
    const answer = promptFunction[type](ns, title)
    if (answer && !(answer instanceof String) && Object.keys(answer).length > 20) {
        ns.tprint(`WARNING: answer size too large to print: ${Object.keys(answer).length}`);
    } else {
        ns.tprint(`INFO: answer: ${answer}`);
    }
    var opts = {};
    opts.returnReward = true;
    var reward = new Number;
  //  var reward = ns.codingcontract.attempt(answer, filename, host, opts);
    if (reward) {
        ns.tprint(`INFO: ${reward}`);
    } else {
        ns.tprint("ERROR: failed!");
    }
}