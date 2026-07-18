import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    let targetDir = "";
    let flags = "";

    for (const arg of ns.args) {
        if (typeof arg === "string" && arg.startsWith("-")) {
            flags += arg.substring(1).toLowerCase();
        } else if (typeof arg === "string" && targetDir === "") {
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
    const files: { name: string, type: string, size: string }[] = [];

    for (const file of allFiles) {
        if (file.startsWith(prefix)) {
            const relativePath = file.substring(prefix.length);
            const slashIndex = relativePath.indexOf('/');
            
            if (slashIndex !== -1) {
                if (!showTree) {
                    directories.add(relativePath.substring(0, slashIndex) + '/');
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
            
            let type = "S";
            let size = ""; 

            if (relativePath.endsWith('.txt')) type = "T";
            else if (relativePath.endsWith('.lit')) type = "L";
            else if (relativePath.endsWith('.exe')) type = "X";
            else if (relativePath.endsWith('.js')) {
                type = "S";
                size = ns.getScriptRam(file).toFixed(2) + "GB";
            }
            
            files.push({ name: relativePath, type, size });
        }
    }

    // Find the longest filename to set the anchor for the Name column
    let maxName = 0;
    directories.forEach(d => maxName = Math.max(maxName, d.length));
    files.forEach(f => maxName = Math.max(maxName, f.name.length));

    // Pad name, then type (2 chars), then size
    const namePad = maxName + 4;
    const formatStr = `%-${namePad}s %-2s %s`;

    const printLine = (name: string, size: string, typeChar: string) => {
        let color = "\x1b[37m"; 
        if (typeChar === "D") color = "\x1b[36m";
        else if (typeChar === "T") color = "\x1b[33m";
        else if (typeChar === "L") color = "\x1b[35m";
        else if (typeChar === "X") color = "\x1b[32m";
        
        ns.tprintf(`${color}${formatStr}\x1b[0m`, name, typeChar, size);
    };

    // Strict grouping order
    if (showDir) directories.forEach(d => printLine(d, "", "D"));
    if (showTxt) files.filter(f => f.type === "T").forEach(f => printLine(f.name, f.size, f.type));
    if (showLit) files.filter(f => f.type === "L").forEach(f => printLine(f.name, f.size, f.type));
    if (showExe) files.filter(f => f.type === "X").forEach(f => printLine(f.name, f.size, f.type));
    if (showScr) files.filter(f => f.type === "S").forEach(f => printLine(f.name, f.size, f.type));
}