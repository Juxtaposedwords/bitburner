/**
 * You are given a string which contains only digits between 0 and 9 as well as a target
 * number. Return all possible ways you can add the +, -, and * operators to the string
 * of digits such that it evaluates to the target number.
 * 
 * The answer should be provided as an array of strings containing the valid expressions.
 * 
 * NOTE: Numbers in an expression cannot have leading 0’s
 * 
 * Examples:
 * Input: digits = "123", target = 6
 * Output: [1+2+3, 1*2*3]
 * 
 * Input: digits = "105", target = 5
 * Output: [1*0+5, 10-5]
 * @param {import("../../..").NS } ns */
export function allMathExpressions(ns, input) {
    var s = input[0];
    var n = input[1];
    return findExpr(s, n, "");
}
function findExpr(s, n, expr) {
    if (s.length == 0) {
        if (eval(expr) == n) {
            return [expr]
        } else {
            return []
        }
    }
    var results = [];
    if (s.startsWith("0")) {
        var sliced = s.slice(1);
        if (expr.length == 0) {
            return findExpr(sliced, n, expr + "0");
        }
        results = results.concat(
            findExpr(sliced, n, expr + "+0"),
            findExpr(sliced, n, expr + "-0"),
            findExpr(sliced, n, expr + "*0"),
        );
        return results;
    }
    var maxLength = s.length;
    var ops = [];
    if (expr.length == 0) {
        ops = ["", "-"];
    } else {
        ops = ["-", "+", "*"];
    }
    for (var op of ops) {
        for (var i = 1; i <= maxLength; i++) {
            results = results.concat(
                findExpr(s.slice(i), n, expr + op + s.slice(0, i))
            );
        }
    }
    return results;
}
