/**
 * Given a string containing only digits, return an array with all possible
 * valid IP address combinations that can be created from the string.
 * 
 * An octet in the IP address cannot begin with ‘0’ unless the number itself
 * is actually 0. For example, "192.168.010.1" is NOT a valid IP.
 * 
 * Examples:
 * 25525511135 -> [255.255.11.135, 255.255.111.35]
 * 1938718066 -> [193.87.180.66]
 * * @param {import("../../..").NS } ns */
export function generate(ns, input) {
    return parseIpNum(ns, input, []);
}
/** @param {String} s
* @Param {Array} parts**/
function parseIpNum(ns, s, parts) {
    if (parts.length == 4) {
        if (s.length == 0) {
            return [parts[0] + "." + parts[1] + "." + parts[2] + "." + parts[3]];
        } else {
            return [];
        }
    }
    if (s.length == 0) {
        return [];
    }
    var results = [];
    if (s.startsWith("0")) {
        parts.push(0);
        results = parseIpNum(ns, s.slice(1), parts);
        parts.pop();
        return results;
    }
    for (var i = 1; i <= 3 && i <= s.length; i++) {
        var n = parseInt(s.slice(0, i));
        if (n > 255) {
            break;
        }
        parts.push(n);
        results = results.concat(parseIpNum(ns, s.slice(i), parts));
        parts.pop();
    }
    return results;
}