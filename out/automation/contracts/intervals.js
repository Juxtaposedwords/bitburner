/** 
 * Given an array of intervals, merge all overlapping intervals. An interval
 * is an array with two numbers, where the first number is always less than
 * the second (e.g. [1, 5]).
 * 
 * The intervals must be returned in ASCENDING order.
 * 
 * Example:
 * [[1, 3], [8, 10], [2, 6], [10, 16]]
 * merges into [[1, 6], [8, 16]]
 * 
 * @param {import("../../..").NS } ns */
export function merge(ns, data) {
    let  intervals = data.slice();
    for (let  i = 0; i < intervals.length; i++) {
        for (let  j = i + 1; j < intervals.length;) {
            let  merged = mergeInterval(intervals, intervals[j]);
            if (merged !== null) {
                intervals = merged;
                intervals.splice(j, 1);
                j = i + 1;
            } else {
                j++
            }
        }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    return intervals;
}
function mergeInterval(a, b) {
    if (a[1] < b[0] || a[0] > b[1]) {
        return null;
    }
    return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}
