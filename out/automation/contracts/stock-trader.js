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
    return maxProfit([1, input]);
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
    return maxProfit([Math.ceil(input.length / 2), input]);

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
    return maxProfit([2, input])
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
    return maxProfit(input)
}



function maxProfit(arrayData) {
    let i, j, k;

    let maxTrades = arrayData[0];
    let stockPrices = arrayData[1];

    // WHY?
    let tempStr = "[0";
    for (i = 0; i < stockPrices.length; i++) {
        tempStr += ",0";
    }
    tempStr += "]";
    let tempArr = "[" + tempStr;
    for (i = 0; i < maxTrades - 1; i++) {
        tempArr += "," + tempStr;
    }
    tempArr += "]";

    let highestProfit = JSON.parse(tempArr);

    for (i = 0; i < maxTrades; i++) {
        for (j = 0; j < stockPrices.length; j++) { // Buy / Start
            for (k = j; k < stockPrices.length; k++) { // Sell / End
                if (i > 0 && j > 0 && k > 0) {
                    highestProfit[i][k] = Math.max(highestProfit[i][k], highestProfit[i - 1][k], highestProfit[i][k - 1], highestProfit[i - 1][j - 1] + stockPrices[k] - stockPrices[j]);
                } else if (i > 0 && j > 0) {
                    highestProfit[i][k] = Math.max(highestProfit[i][k], highestProfit[i - 1][k], highestProfit[i - 1][j - 1] + stockPrices[k] - stockPrices[j]);
                } else if (i > 0 && k > 0) {
                    highestProfit[i][k] = Math.max(highestProfit[i][k], highestProfit[i - 1][k], highestProfit[i][k - 1], stockPrices[k] - stockPrices[j]);
                } else if (j > 0 && k > 0) {
                    highestProfit[i][k] = Math.max(highestProfit[i][k], highestProfit[i][k - 1], stockPrices[k] - stockPrices[j]);
                } else {
                    highestProfit[i][k] = Math.max(highestProfit[i][k], stockPrices[k] - stockPrices[j]);
                }
            }
        }
    }
    return highestProfit[maxTrades - 1][stockPrices.length - 1];
}