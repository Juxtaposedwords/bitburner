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
    let solutions = new Set();

    // Returns true and adds to solutions set if a string contains valid parentheses, false otherwise
    let checkValidity = (str) => {
        let nestLevel = 0;
        for (let c of str) {
            if (c == "(") nestLevel++;
            else if (c == ")") nestLevel--;
            if (nestLevel < 0) return false;
        }

        if (nestLevel == 0) solutions.add(str);
        return nestLevel == 0;
    };

    // Does a breadth first search to check all nodes at the target depth
    let getNodesAtDepth = (str, targetDepth, curDepth = 0) => {
        if (curDepth == targetDepth)
            checkValidity(str);
        else
            for (let i = 0; i < str.length; i++)
                if (str[i] == "(" || str[i] == ")")
                    getNodesAtDepth(str.slice(0, i) + str.slice(i + 1), targetDepth, curDepth + 1);
    }

    // Start from the top level and expand down until we find at least one solution
    let targetDepth = 0;
    while (solutions.size == 0 && targetDepth < input.length - 1) {
        getNodesAtDepth(input, targetDepth++);
    }

    // If no solutions were found, return [""]
    if (solutions.size == 0) solutions.add("");
    return `[${[...solutions].join(", ")}]`;
}