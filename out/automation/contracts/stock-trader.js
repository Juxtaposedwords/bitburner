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

    var windows = findProfitWindows(input);

    var mergedWindows = mergeWindows(windows);
    var profit = Math.max(...(mergedWindows.map(cs => Math.max(...(cs.map(c => c[1] - c[0]))))));

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

    var windows = findProfitWindows(input);
    var profit = windows.map(c => c[1] - c[0]).reduce((a, b) => a + b, 0);

    return profit;

}


function findProfitWindows(input) {
    var start = input[0];
    var end = start;
    var windows = [];
    for (var i = 1; i < input.length; i++) {
        var now = input;
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
        var ncs = [];
        for (var i = 0; i < cs.length - 1; i++) {
            ncs.push([cs[i][0], cs[i + 1][1]]);
        }
        mergeWindows.push(ncs);
        cs = ncs;
    }
    mergeWindows.reverse();
    return mergeWindows;
}