import { NS } from "@ns";

const HELP_FLAGS = ["help", "-h", "--help"];

function printHelp(ns: NS): void {
    ns.tprint(
        [
            "Usage: run tools/scan.js [-a] [-p] [-d <depth>] [help]",
            "  -a          Show the full network tree (equivalent to -d 99).",
            "  -p          Show port/skill details (Req, SSH, FTP, SMTP, HTTP, SQL columns).",
            "  -d <depth>  Limit the tree to <depth> hops from home (default: 1, or 99 with -a).",
            "  help        Show this message.",
        ].join("\n")
    );
}

/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
    if (ns.args.some((arg) => HELP_FLAGS.includes(String(arg)))) {
        printHelp(ns);
        return;
    }

    const showAll: boolean = ns.args.includes("-a");
    const showDetails: boolean = ns.args.includes("-p");
    
    const dIndex = ns.args.indexOf("-d");
    const maxDepthLimit = (dIndex !== -1 && ns.args[dIndex + 1] !== undefined) 
        ? Number(ns.args[dIndex + 1]) 
        : (showAll ? 99 : 1);

    const currentHackLvl = ns.getHackingLevel();

    // 1. Pre-calculate all display names to find the absolute longest string
    const renderedServers: { host: string, display: string, depth: number }[] = [];
    
    const collectRendered = (host: string, parent: string, depth: number) => {
        if (depth > maxDepthLimit) return;
        const indent = "  ".repeat(depth);
        const display = depth > 0 ? `${indent}↳ ${host}` : host;
        renderedServers.push({ host, display, depth });
        
        const children = ns.scan(host).filter(c => c !== parent && c !== "home");
        children.forEach(child => collectRendered(child, host, depth + 1));
    };
    
    collectRendered("home", "", 0);

    // Find the longest string that will actually be printed
    const longestRendered = renderedServers.reduce((max, s) => Math.max(max, s.display.length), 0);
    const hostColWidth = longestRendered + 2; // Add a little buffer

    const green = "\u001b[32m";
    const red = "\u001b[31m";
    const cyan = "\u001b[36m";
    const yellow = "\u001b[33m";
    const white = "\u001b[37m";
    const reset = "\u001b[0m";

    const center = (text: string, width: number, color: string): string => {
        const totalPadding = width - text.length;
        const left = Math.floor(totalPadding / 2);
        const right = totalPadding - left;
        return `${color}${" ".repeat(left)}${text}${" ".repeat(right)}${reset}`;
    };

    // Build every row as one combined string, printed in a single ns.tprint
    // call at the end - Bitburner prefixes each individual ns.tprint/tprintf
    // call with "tools/scan.js: ", so per-row printing would repeat that
    // prefix on every line of the table instead of once.
    const outputLines: string[] = [];

    // Header
    let headerFormat = `%-${hostColWidth}s %-10s %-8s`;
    const headerArgs: (string | number)[] = [
        "Hostname", center("Root", 10, cyan), center("H.Lvl", 8, cyan)
    ];

    if (showDetails) {
        headerFormat += ` %-5s %-5s %-5s %-5s %-5s %-5s`;
        headerArgs.push("Req", "SSH", "FTP", "SMTP", "HTTP", "SQL");
    }
    outputLines.push(ns.sprintf(headerFormat, ...headerArgs));

    // 2. Build a row for each server in the pre-calculated list
    for (const item of renderedServers) {
        const s = ns.getServer(item.host);
        const hasRoot = s.hasAdminRights ?? false;
        const portsReq = s.numOpenPortsRequired ?? 0;
        const hackReq = s.requiredHackingSkill ?? 0;
        
        const rootStatus = center(hasRoot ? "Y" : "N", 10, hasRoot ? green : red);
        const hackStatus = center(hackReq.toString(), 8, hackReq <= currentHackLvl ? green : red);

        let rowFormat = `%-${hostColWidth}s %s %s`;
        const rowArgs: (string | number)[] = [item.display, rootStatus, hackStatus];

        if (showDetails) {
            rowFormat += ` %-5s %-5s %-5s %-5s %-5s %-5s`;
            rowArgs.push(
                center(portsReq.toString(), 5, portsReq === 0 ? green : white),
                center(s.sshPortOpen ? "Y" : "N", 5, s.sshPortOpen ? green : red),
                center(s.ftpPortOpen ? "Y" : "N", 5, s.ftpPortOpen ? green : red),
                center(s.smtpPortOpen ? "Y" : "N", 5, s.smtpPortOpen ? green : red),
                center(s.httpPortOpen ? "Y" : "N", 5, s.httpPortOpen ? green : red),
                center(s.sqlPortOpen ? "Y" : "N", 5, s.sqlPortOpen ? green : red)
            );
        }
        outputLines.push(ns.sprintf(rowFormat, ...rowArgs));
    }

    ns.tprint(outputLines.join("\n"));
}