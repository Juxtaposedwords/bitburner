import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    let targetDir = "";
    let flags = "";

    for (const arg of ns.args) {
        if (typeof arg === "string" && arg.startsWith("-")) {
            flags += arg.substring(1);
        } else if (typeof arg === "string") {
            targetDir = arg;
        }
    }

    const showTree = flags.includes("r");
    const typeFlags = flags.replace(/r/g, "");
    
    const showAll = typeFlags.length === 0;
    const showDir = showAll || typeFlags.includes("d");
    const showTxt = showAll || typeFlags.includes("t");
    const showLit = showAll || typeFlags.includes("l");
    const showExe = showAll || typeFlags.includes("x");
    const showScr = showAll || typeFlags.includes("s");

    const prefix = (targetDir && !targetDir.endsWith('/')) ? targetDir + '/' : targetDir;
    const allFiles = ns.ls(ns.getHostname());
    
    const directories = new Set<string>();
    const textFiles: string[] = [];
    const litFiles: string[] = [];
    const exeFiles: string[] = [];
    const otherFiles: string[] = [];

    for (const file of allFiles) {
        if (file.startsWith(prefix)) {
            const relativePath = file.substring(prefix.length);
            const slashIndex = relativePath.indexOf('/');
            
            if (slashIndex !== -1) {
                if (!showTree) {
                    const dirName = relativePath.substring(0, slashIndex);
                    directories.add(dirName + '/');
                    continue; 
                } else {
                    const parts = relativePath.split('/');
                    let currentPath = "";
                    for (let i = 0; i < parts.length - 1; i++) {
                        currentPath += parts[i] + '/';
                        directories.add(currentPath);
                    }
                }
            }
            
            if (relativePath.endsWith('.txt')) textFiles.push(relativePath);
            else if (relativePath.endsWith('.lit')) litFiles.push(relativePath);
            else if (relativePath.endsWith('.exe')) exeFiles.push(relativePath);
            else otherFiles.push(relativePath);
        }
    }

    let maxLength = 0;
    let matchCount = 0;

    if (showDir) { directories.forEach(dir => maxLength = Math.max(maxLength, dir.length)); matchCount += directories.size; }
    if (showTxt) { textFiles.forEach(file => maxLength = Math.max(maxLength, file.length)); matchCount += textFiles.length; }
    if (showLit) { litFiles.forEach(file => maxLength = Math.max(maxLength, file.length)); matchCount += litFiles.length; }
    if (showExe) { exeFiles.forEach(file => maxLength = Math.max(maxLength, file.length)); matchCount += exeFiles.length; }
    if (showScr) { otherFiles.forEach(file => maxLength = Math.max(maxLength, file.length)); matchCount += otherFiles.length; }
    
    if (matchCount === 0) {
        ns.tprintf("  (No matching files found)");
        return;
    }

    const padding = maxLength > 0 ? maxLength + 4 : 4;
    const formatStr = `%-${padding}s %s`;

    // Define colors: D=Cyan, T=Yellow, L=Magenta, X=Green, S=White
    const printLine = (name: string, typeChar: string) => {
        let color = "\x1b[37m"; // White default
        if (typeChar === "D") color = "\x1b[36m";
        else if (typeChar === "T") color = "\x1b[33m";
        else if (typeChar === "L") color = "\x1b[35m";
        else if (typeChar === "X") color = "\x1b[32m";
        else if (typeChar === "S") color = "\x1b[37m";

        ns.tprintf(`${color}${formatStr}\x1b[0m`, name, typeChar);
    };
    
    if (showDir) directories.forEach(dir => printLine(dir, "D"));
    if (showTxt) textFiles.forEach(file => printLine(file, "T"));
    if (showLit) litFiles.forEach(file => printLine(file, "L"));
    if (showExe) exeFiles.forEach(file => printLine(file, "X"));
    if (showScr) otherFiles.forEach(file => printLine(file, "S"));
}