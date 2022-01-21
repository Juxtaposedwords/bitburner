/** @param {import("../../..").NS } ns */

// pad blank-pads elements in a multi-column array so that all elements in the same
// column have the same width.
export function pad(ns, arr) {
    for (let i = 0; i < arr[0].length; i++) {
        const max = Math.max(...(arr.map((r) => String(r[i]).length)));
        arr.forEach((s, j) => arr[j][i] = String(s[i]).padEnd(max + 1), ' ')
    }
}