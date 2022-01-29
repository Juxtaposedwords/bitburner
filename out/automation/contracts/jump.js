/** @param {import("../../..").NS } ns */
export function jumpable(ns, input) {
    return findJump(input, 0);
}


function findJump(data, pos) {
    var maxJump = data[pos];
    if (pos + maxJump >= data.length - 1) {
        return 1;
    }
    for (var i = 1; i <= maxJump; i++) {
        if (findJump(data, pos + i) == 1) {
            return 1;
        }
    }
    return 0;
}


