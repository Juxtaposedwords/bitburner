import { NS } from "@ns";

// Only these extensions are valid scripts as far as ns.getScriptRam is
// concerned - everything else (.msg lore files, .cct contracts, .json,
// .css, ...) must not be queried for RAM cost, or it throws.
const SCRIPT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx"];

function classify(key: string, isDir: boolean): string {
    if (isDir) return "D";
    if (key.endsWith(".txt")) return "T";
    if (key.endsWith(".lit")) return "L";
    if (key.endsWith(".exe")) return "X";
    if (key.endsWith(".msg")) return "M";
    if (key.endsWith(".cct")) return "C";
    if (SCRIPT_EXTENSIONS.some((ext) => key.endsWith(ext))) return "S";
    return "F";
}

const COLOR_BY_TYPE: Record<string, string> = {
    D: "\x1b[36m", // cyan
    T: "\x1b[33m", // yellow
    L: "\x1b[35m", // magenta
    X: "\x1b[32m", // green
    M: "\x1b[34m", // blue
    C: "\x1b[31m", // red
    S: "\x1b[37m", // white
    F: "\x1b[90m", // gray
};

export async function main(ns: NS): Promise<void> {
    const args = ns.flags([['d', '']]);
    
    // Cast args._ to string[] so TypeScript knows it can be indexed
    let targetDir = ((args._ as string[])[0] || args.d || "").toString();

    // Ensure directory format is correct for ls filtering
    // If you pass "tools", we want to search for "tools/"
    if (targetDir.length > 0 && !targetDir.endsWith('/')) {
        targetDir += '/';
    }

    // Use Bitburner's native filtering
    const allFiles = ns.ls(ns.getHostname(), targetDir);
    
    // Build tree
    const tree: any = {};
    for (const file of allFiles) {
        // Strip the targetDir to make paths relative to the folder we're "in"
        const relativePath = file.substring(targetDir.length);
        const parts = relativePath.split('/').filter(p => p !== "");
        
        let current = tree;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            if (!current[part]) {
                current[part] = { _isDir: !isFile, _children: {} };
            }
            if (isFile) current[part]._isDir = false;
            current = current[part]._children;
        }
    }

    // Helper for alignment
    const getMaxBranchWidth = (node: any, indent: string): number => {
        let max = 0;
        Object.keys(node).forEach(key => {
            const branchText = `${indent}├── ${key}`;
            max = Math.max(max, branchText.length, getMaxBranchWidth(node[key]._children, indent + "│   "));
        });
        return max;
    };
    const globalBranchWidth = getMaxBranchWidth(tree, "");

    const printNode = (node: any, indent: string, path: string) => {
        const entries = Object.keys(node).map(key => ({
            key,
            isDir: node[key]._isDir,
            children: node[key]._children,
            type: classify(key, node[key]._isDir)
        }));

        const sorted = entries.sort((a, b) => (a.type === b.type ? a.key.localeCompare(b.key) : a.type.localeCompare(b.type)));

        sorted.forEach((e, i) => {
            const isLast = i === sorted.length - 1;
            const fullPath = targetDir + (path ? `${path}/` : "") + e.key;
            const size = e.type === "S" ? ns.getScriptRam(fullPath).toFixed(2) + "GB" : "";

            const color = COLOR_BY_TYPE[e.type];

            const marker = isLast ? "└── " : "├── ";
            const branchText = `${indent}${marker}${e.key}`;
            const padding = " ".repeat(Math.max(0, globalBranchWidth - branchText.length + 2));
            
            // Every dynamic piece (branchText embeds the raw filename) must
            // go through a %s argument, never be spliced into the format
            // string itself - a filename containing a literal "%" would
            // otherwise be re-parsed by sprintf as a placeholder and throw.
            ns.tprintf("%s%s%s%s %s\x1b[0m", color, branchText, padding, e.type, size);
            if (e.isDir) printNode(e.children, indent + (isLast ? "    " : "│   "), path ? `${path}/${e.key}` : e.key);
        });
    };
    
    ns.tprintf("\x1b[37m%s\x1b[0m", targetDir || ".");
    printNode(tree, "", "");
}