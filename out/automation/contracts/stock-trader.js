/** 
 * You are given an array of numbers representing stock prices, where the
 * i-th element represents the stock price on day i.
 *
 * Determine the maximum possible profit you can earn using at most one
 * transaction (i.e. you can buy an sell the stock once). If no profit
 * can be made, then the answer should be 0. Note that you must buy the stock
 * before you can sell it.
 * 
 * @param {import("../../..").NS } ns */
export function oneTransaction(ns, input) {
    if (input.length == 0) {

        return 0;

    }

    let windows = findProfitWindows(input);

    let mergedWindows = mergeWindows(windows);
    let profit = Math.max(...(mergedWindows.map(cs => Math.max(...(cs.map(c => c[1] - c[0]))))));

    return profit;
}

/**
 * You are given an array of numbers representing stock prices, where the
 * i-th element represents the stock price on day i.
 * 
 * Determine the maximum possible profit you can earn using as many transactions
 * as you’d like. A transaction is defined as buying and then selling one
 * share of the stock. Note that you cannot engage in multiple transactions at
 * once. In other words, you must sell the stock before you buy it again. If no
 * profit can be made, then the answer should be 0.
 * @param {import("../../..").NS } ns */
export function unlimitedTransactions(ns, input) {

    if (input.length == 0) {
        return 0;
    }

    let windows = findProfitWindows(input);
    let profit = windows.map(c => c[1] - c[0]).reduce((a, b) => a + b, 0);

    return profit;

}


/** 
 * You are given an array of numbers representing stock prices, where the
 * i-th element represents the stock price on day i.
 * 
 * Determine the maximum possible profit you can earn using at most two
 * transactions. A transaction is defined as buying and then selling one share
 * of the stock. Note that you cannot engage in multiple transactions at once.
 * In other words, you must sell the stock before you buy it again. If no profit
 * can be made, then the answer should be 0.
 * @param {import("../../..").NS } ns */
export function twoTransactions(ns, input) {
    if (input.length == 0) {
        return 0;
    }

    let windows = findProfitWindows(input);
    return maxProfit(windows, 2);

}


/**
 *   You are given an array with two elements. The first element is an integer k.
 * The second element is an array of numbers representing stock prices, where the
 * i-th element represents the stock price on day i.
 * 
 *   Determine the maximum possible profit you can earn using at most k transactions.
 * A transaction is defined as buying and then selling one share of the stock.
 * Note that you cannot engage in multiple transactions at once. In other words,
 * you must sell the stock before you can buy it. If no profit can be made, then
 * the answer should be 0.
 * @param {import("../../..").NS } ns */
 export function kTransactions(ns, input) {
    if (input[1].length == 0) {
        return 0;
    }

    let windows = findProfitWindows(input[1]);
    return maxProfit(windows, input[0]);

}

/**
 *  fredProfit didn't have the same ring.*/
function maxProfit(windows, k) {
    if (k == 0 || windows.length == 0) {
        return 0;
    }

    let c0 = windows[0];
    if (windows.length == 1) {
        return c0[1] - c0[0];
    }

    let profit = maxProfit(windows.slice(1), k);

    for (let i = 0; i < windows.length; i++) {
        let p = windows[1] - windows[0][0] + maxProfit(windows.slice(i + 1), k - 1);
        if (p > profit) {
            profit = p;
        }
    }
    return profit;
}


function findProfitWindows(input) {
    let start = input[0];
    let end = start;
    let windows = [];
    for (let i = 1; i < input.length; i++) {
        let now = input;
        if (end < now) {
            end = now;
        }
        if (end > now) {
            if (end > start) {
                windows.push([start, end]);
            }
            start = now;
            end = start;
        }
    }
    if (end > start) {
        windows.push([start, end]);
    }

    return windows;

}


function mergeWindows(windows) {
    let mergeWindows = [];
    let cs = windows.slice();
    mergeWindows.push(cs);
    while (cs.length > 1) {
        let ncs = [];
        for (let i = 0; i < cs.length - 1; i++) {
            ncs.push([cs[i][0], cs[i + 1][1]]);
        }
        mergeWindows.push(ncs);
        cs = ncs;
    }
    mergeWindows.reverse();
    return mergeWindows;
}