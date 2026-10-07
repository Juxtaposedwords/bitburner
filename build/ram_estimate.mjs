// Estimates a script's RAM the way the game does, offline - for sizing
// scripts before they ever reach the game (the faction daemon split had to
// fit early hacked servers):
//
//   node build/ram_estimate.mjs [--root dist] [--costs game/var/claude_out/ram_costs.txt] script.js...
//
// The game's rule (its RAM calculator, read for this - not copied): every
// identifier a script can reach is looked up by bare name among the game's
// functions and charged once. Reachable means: everything in the main
// script's global scope and its top-level functions, plus - through imports
// - each imported module's global scope and the top-level functions actually
// referenced (transitively). `import * as m` reaches all of m. Comments and
// object-literal keys never count; member names (`x.exec`) and plain
// identifiers do, whatever object they belong to.
//
// The price list comes from tools/ram_costs.js run in the game.
import fs from "fs";
import path from "path";
import * as acorn from "acorn";

const BASE = 1.6;
const GLOBAL = ".__GLOBAL__";
const OBJECT_PROTO = Object.getOwnPropertyNames(Object.prototype);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = arg("--root", "dist");
const costsFile = arg("--costs", "game/var/claude_out/ram_costs.txt");
// Flags that take a value; --detail doesn't.
const VALUED = ["--root", "--costs"];
const scripts = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !VALUED.includes(all[i - 1]));

// Bare name -> cost, top-level functions first (the game searches them before namespaces).
const priceList = JSON.parse(fs.readFileSync(costsFile, "utf8"));
const costOf = new Map();
for (const { path: p, cost } of [...priceList].sort((a, b) => a.path.split(".").length - b.path.split(".").length)) {
  const bare = p.split(".").pop();
  if (!costOf.has(bare)) costOf.set(bare, { cost, path: p });
}

function moduleFile(name) {
  const clean = name.replace(/^\.?\//, "");
  return clean.endsWith(".js") ? clean : `${clean}.js`;
}

// Every child node of an ESTree node, generically.
function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) for (const v of value) v && typeof v.type === "string" && out.push(v);
    else if (value && typeof value.type === "string") out.push(value);
  }
  return out;
}

/** One module's dependency map: key -> referenced names (bare, module-qualified, or imports). */
function parseModule(file, deps, queue) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const globalKey = file + GLOBAL;
  const internalToExternal = {};
  const add = (key, name) => {
    const set = deps[key] ?? (deps[key] = new Set());
    if (internalToExternal[name]) set.add(internalToExternal[name]);
    set.add(`${file}.${name}`);
    set.add(name);
  };
  deps[globalKey] ??= new Set();

  // Identifiers anywhere below `node`, charged to `key`. Object-literal keys
  // (non-computed) aren't identifiers the game visits.
  const collect = (node, key) => {
    if (node.type === "Identifier") {
      if (!OBJECT_PROTO.includes(node.name)) add(key, node.name);
      return;
    }
    if (node.type === "Property" && !node.computed) {
      collect(node.value, key);
      return;
    }
    if (node.type === "MethodDefinition" || node.type === "PropertyDefinition") {
      if (node.computed) collect(node.key, key);
      if (node.value) collect(node.value, key);
      return;
    }
    for (const child of children(node)) collect(child, key);
  };

  const visitTop = (node) => {
    switch (node.type) {
      case "ImportDeclaration": {
        const source = node.source.value;
        if (source === "@ns" || source === "@nsdefs") return;
        const target = moduleFile(source);
        queue.push(target);
        deps[globalKey].add(target + GLOBAL);
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") internalToExternal[spec.local.name] = `${target}.${spec.imported.name}`;
          else deps[globalKey].add(`${target}.*`);
        }
        return;
      }
      case "FunctionDeclaration":
        collect(node, `${file}.${node.id ? node.id.name : "__SPECIAL_DEFAULT_EXPORT__"}`);
        return;
      case "ExportNamedDeclaration":
        if (node.declaration) visitTop(node.declaration);
        else if (node.source) queue.push(moduleFile(node.source.value));
        return;
      case "ExportDefaultDeclaration":
        visitTop(node.declaration);
        return;
      default:
        collect(node, globalKey);
    }
  };
  for (const node of ast.body) visitTop(node);
}

export function estimate(script) {
  const deps = {};
  const parsed = new Set();
  const queue = [moduleFile(script)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (parsed.has(file)) continue;
    parsed.add(file);
    if (!fs.existsSync(path.join(root, file))) continue;
    parseModule(file, deps, queue);
  }
  const main = moduleFile(script);
  const pending = Object.keys(deps).filter((k) => k.startsWith(main));
  const seen = new Set();
  const charged = new Map();
  while (pending.length > 0) {
    const ref = pending.shift();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const next = ref.endsWith(".*")
      ? Object.keys(deps).filter((k) => k.startsWith(ref.slice(0, -2))).flatMap((k) => [...deps[k]])
      : [...(deps[ref] ?? [])];
    for (const dep of next) if (!seen.has(dep)) pending.push(dep);
    const price = costOf.get(ref);
    if (price && !charged.has(ref)) charged.set(ref, price);
  }
  const total = BASE + [...charged.values()].reduce((s, p) => s + p.cost, 0);
  return { total, charged: [...charged.values()].sort((a, b) => b.cost - a.cost) };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  for (const script of scripts) {
    const { total, charged } = estimate(script);
    console.log(`${script}: ${total.toFixed(2)} GB`);
    if (process.argv.includes("--detail")) for (const p of charged) console.log(`  ${p.cost.toFixed(2).padStart(6)}  ${p.path}`);
  }
}
