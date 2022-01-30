/**
 * Given a number, how many different ways can that number be written as
 * a sum of at least two positive integers?
 * @param {import("../../..").NS } ns */
export function totalWayToSum(ns, input) {
    let cache = {};
    let n = input;
    return waysToSum(n, n, cache) - 1;
}
/**
 * Given an array of integers, find the contiguous subarray (containing
 * at least one number) which has the largest sum and return that sum.
 * @param {import("../../..").NS } ns */
export function subarrayWithMaxSum(ns, input) {
    let maxSum = input[0] + input[1]
    for (let i = 0; i < input.length ; i++) {
        for (let j = i+1; j <= input.length; j++) {
            let sum = Number;
            sum = input.slice(i, j).reduce((a, b) => a + b);
            if (sum > maxSum) {
                maxSum = sum
            }
        }
    }
    return maxSum
}

function waysToSum(limit, n, cache) {
    if (n < 1) {
        return 1;
    }
    if (limit == 1) {
        return 1;
    }
    if (n < limit) {
        return waysToSum(n, n, cache);
    }
    if (n in cache) {
        let c = cache[n];
        if (limit in c) {
            return c[limit];
        }
    }
    let s = 0;
    for (let i = 1; i <= limit; i++) {
        s += waysToSum(i, n - i, cache);
    }
    if (!(n in cache)) {
        cache[n] = {};
    }
    cache[n][limit] = s; return s;
}