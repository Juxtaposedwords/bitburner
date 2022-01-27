/** @param {import("../../..").NS } ns */
export function triangle(ns, input) {

    var length = input.length;
    if (length == 1) { return input[0][0];}

    var r = input[length - 1].slice();

    for (var i = length - 2; i >= 0; i--) {

        var currentRow = input;
        let nextRow = [];

        for (var j = 0; j < i + 1; j++) {
            nextRow.push(Math.min(r[j] + currentRow[j], r[j + 1] + currentRow[j]));
        }
        r = nextRow;
    }

    return r[0];

}
