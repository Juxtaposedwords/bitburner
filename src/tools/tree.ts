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

    const showAll = flags.replace(/r/g, "").length === 0;
    const showDir = showAll || flags.includes("d");
    const showTxt = showAll || flags.includes("t");
    const showLit = showAll || flags.includes("l");
    const showExe = showAll || flags.includes("x");
    const showScr = showAll || flags.includes("s");

    const prefix = (targetDir && !targetDir.endsWith('/')) ? targetDir + '/' : targetDir;
    const allFiles = ns.ls(ns.getHostname());

    const buildTree = () => {
        const root: any = {};
        for (const file of allFiles) {
            if (file.startsWith(prefix)) {
                const parts = file.substring(prefix.length).split('/').filter(p => p !== "");
                let current = root;
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (!current[part]) current[part] = { _isDir: i < parts.length - 1, _children: {} };
                    current = current[part]._children;
                }
            }
        }
        return root;
    };

    const tree = buildTree();

    // Calculate dynamic global width of the longest tree branch string
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
        const entries = Object.keys(node).map(key => {
            const isDir = node[key]._isDir;
            let type = isDir ? "D" : (key.endsWith('.txt') ? "T" : key.endsWith('.lit') ? "L" : key.endsWith('.exe') ? "X" : "S");
            return { key, type, isDir, children: node[key]._children };
        });

        const sorted = entries
            .filter(e => (e.type === "D" && showDir) || (e.type === "T" && showTxt) || (e.type === "L" && showLit) || (e.type === "X" && showExe) || (e.type === "S" && showScr))
            .sort((a, b) => (a.type === b.type ? a.key.localeCompare(b.key) : a.type.localeCompare(b.type)));

        sorted.forEach((e, i) => {
            const isLast = i === sorted.length - 1;
            const fullPath = path ? `${path}/${e.key}` : e.key;
            const size = e.type === "S" ? ns.getScriptRam(fullPath).toFixed(2) + "GB" : "";
            
            let color = e.type === "D" ? "\x1b[36m" : e.type === "T" ? "\x1b[33m" : e.type === "L" ? "\x1b[35m" : e.type === "X" ? "\x1b[32m" : "\x1b[37m";

            const marker = isLast ? "└── " : "├── ";
            const branchText = `${indent}${marker}${e.key}`;
            
            // Padding fills the gap between the end of the filename and the global column anchor
            const padding = " ".repeat(globalBranchWidth - branchText.length + 2);
            
            ns.tprintf(`${color}${branchText}${padding}%s %s\x1b[0m`, e.type, size);

            if (e.isDir) printNode(e.children, indent + (isLast ? "    " : "│   "), fullPath);
        });
    };

    ns.tprintf("\x1b[37m.\x1b[0m");
    printNode(tree, "", "");
}