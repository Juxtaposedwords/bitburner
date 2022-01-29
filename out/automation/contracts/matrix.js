/** 
 * Given an array of array of numbers representing a 2D matrix, return the
 * elements of that matrix in clockwise spiral order.
 * 
 * Example: The spiral order of
 * 
 * [1, 2, 3, 4]
 * [5, 6, 7, 8]
 * [9, 10, 11, 12]
 * 
 * is [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]
 * @param {import("../../..").NS } ns */
export function spiralize(ns, input) {
    let s = 0;
    let m = [];
    for (let i = 0; i < input.length; i++) {
        m.push(input.slice());
    }
    let a = [];
    while (m.length > 0 && m[0].length > 0) {
        switch (s) {
            case 0:
                a = a.concat(m[0]);
                m = m.slice(1);
                s = 1;
                break;
            case 1:
                for (let i = 0; i < m.length; i++) {
                    a.push(m.pop());
                }
                s = 2;
                break;
            case 2:
                a = a.concat(m.pop().reverse());
                s = 3;
                break;
            case 3:
                for (let i = m.length - 1; i >= 0; i--) {
                    a.push(m[0]);
                    m = m.slice(1);
                }
                s = 0;
                break;
        }
    }
    return a;
}