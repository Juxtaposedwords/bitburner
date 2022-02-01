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
export function merge(ns, intervals) {
    intervals.sort(([minA], [minB]) => minA - minB);
    for (let i = 0; i < intervals.length; i++) {
        for (let j = i + 1; j < intervals.length; j++) {
            const [min, max] = intervals[i];
            const [laterMin, laterMax] = intervals[j];
            if (laterMin <= max) {
                const newMax = laterMax > max ? laterMax : max;
                const newInterval = [min, newMax];
                intervals[i] = newInterval;
                intervals.splice(j, 1);
                j = i;
            }
        }
    }
    return intervals;
}