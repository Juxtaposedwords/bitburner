/**
 * Given a number, how many different ways can that number be written as
 * a sum of at least two positive integers?
 * @param {import("../../..").NS } ns */
function totalWayToSum(ns, input) {
    let cache = {};
    let n = input;
    return waysToSum(n, n, cache) - 1;
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