/**
 * Given a string with parentheses and letters, remove the minimum number of invalid
 * parentheses in order to validate the string. If there are multiple minimal ways
 * to validate the string, provide all of the possible results.
 * 
 * The answer should be provided as an array of strings. If it is impossible to validate
 * the string, the result should be an array with only an empty string.
 * 
 * Examples:
 * ()())() -> [()()(), (())()]
 * (a)())() -> [(a)()(), (a())()]
 * )( -> [""]
 * 
 *  @param {import("../../..").NS } ns */
export function sanitize(ns, input) {
    let context = {"maxLeftLength": 0}
    let exprs = findSanitized(ns, input, 0, context);

    exprs = exprs.filter(e => e.length >= context["maxLeftLength"]).sort();
    for (let i = 0; i < exprs.length - 1; i++) {
        while (exprs == exprs[i + 1]) {
            exprs.splice(i + 1, 1);
        }
    }
    return exprs;
}


function findSanitized(ns, s, pos, context) {
    if (s.length < context["maxLeftLength"]) {
        return [];
    }
    if (pos == s.length) {
        if (validateParentheses(s)) {
            if (s.length > context["maxLeftLength"]) {
                context["maxLeftLength"] = s.length;
            }
            return [s];
        } else {
            return []
        }
    }
    let results = [];
    let c = s[pos];
    if (c == "(" || c == ")") {
        results = results.concat(
            findSanitized(ns, s, pos + 1, context),
            findSanitized(ns, s.slice(0, pos) + s.slice(pos + 1), pos, context)
        );
    } else {
        results = results.concat(
            findSanitized(ns, s, pos + 1, context)
        );
    }
    return results;
}


function validateParentheses(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s == "(") {
           n++;
        }
        if (s == ")") {
            n--;
        }
        if (n < 0) {
            return false;
        }
    }
    return n == 0;
}
