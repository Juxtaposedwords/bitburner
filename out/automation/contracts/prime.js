/** @param {import("../../..").NS } ns */
function largestPrimeFactor(ns, input) {

    let factor = 0;
    let numb = input;
    let sqrt = Math.sqrt(numb);

    for (var i = 2; i < sqrt;) {

        if (numb % i == 0) {
            factor = i;
            numb /= i;
            sqrt = Math.sqrt(numb);
        } else {
            i++;
        }
    }
    return numb > factor ? numb : factor;

}