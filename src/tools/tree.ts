import { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const args = ns.flags([['d', '']]);
    // If no argument is provided, default to empty string (root)
    let targetDir = (args._[0] || args.d || "").toString();

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
            type: node[key]._isDir ? "D" : (key.endsWith('.txt') ? "T" : key.endsWith('.lit') ? "L" : key.endsWith('.exe') ? "X" : "S")
        }));

        const sorted = entries.sort((a, b) => (a.type === b.type ? a.key.localeCompare(b.key) : a.type.localeCompare(b.type)));

        sorted.forEach((e, i) => {
            const isLast = i === sorted.length - 1;
            const fullPath = targetDir + (path ? `${path}/` : "") + e.key;
            const size = e.type === "S" ? ns.getScriptRam(fullPath).toFixed(2) + "GB" : "";
            
            let color = e.type === "D" ? "\x1b[36m" : e.type === "T" ? "\x1b[33m" : e.type === "L" ? "\x1b[35m" : e.type === "X" ? "\x1b[32m" : "\x1b[37m";

            const marker = isLast ? "└── " : "├── ";
            const branchText = `${indent}${marker}${e.key}`;
            const padding = " ".repeat(Math.max(0, globalBranchWidth - branchText.length + 2));
            
            ns.tprintf(`${color}${branchText}${padding}%s %s\x1b[0m`, e.type, size);
            if (e.isDir) printNode(e.children, indent + (isLast ? "    " : "│   "), path ? `${path}/${e.key}` : e.key);
        });
    };

    ns.tprintf("\x1b[37m%s\x1b[0m", targetDir || ".");
    printNode(tree, "", "");
}