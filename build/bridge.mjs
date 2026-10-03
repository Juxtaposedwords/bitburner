// Two-way bridge to the game's Remote API - a stand-in for
// bitburner-filesync that also reads from the game.
//
//   npm run watch            (runs this as watch:remote)
//   node build/bridge.mjs    (on its own)
//
// The game connects to this websocket server (Options > Remote API, port
// from filesync.json). Then:
// - push: every file in dist/ on connect, and each one as it changes or
//   is deleted (what filesync did);
// - pull: every PULL_INTERVAL_MS, the game's files under PULL_PREFIXES are
//   copied into ./game/ (status files, daemon logs, monitoring series,
//   command output) - only rewritten when their content changed.
// Only one Remote API server can be connected at a time, so this replaces
// filesync rather than running beside it.
import { WebSocketServer } from "ws";
import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync("filesync.json", "utf8"));
const PORT = Number(process.env.BRIDGE_PORT ?? config.port ?? 12525);
const DIST = config.scriptsFolder ?? "dist";
const EXTENSIONS = config.allowedFiletypes ?? [".js", ".txt"];
const MIRROR = process.env.BRIDGE_MIRROR ?? "game";
// BRIDGE_* overrides exist for testing against a fake game.
const DEFS_PATH = process.env.BRIDGE_DEFS ?? config.definitionFile?.location ?? "NetscriptDefinitions.d.ts";
const PULL_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
// Game paths copied into ./game/ (leading slash optional in the game's names).
// /var/claude_out/ holds tool output written for this (e.g. status --out).
const PULL_PREFIXES = ["var/"];
// Under a pulled prefix but not worth copying (one file per server, rewritten constantly).
const PULL_SKIP = ["var/supervisor/"];

const log = (...args) => console.log(`[bridge ${new Date().toLocaleTimeString()}]`, ...args);
const gamePath = (rel) => (rel.includes("/") ? `/${rel}` : rel);
const relPath = (name) => name.replace(/^\//, "");
const allowed = (file) => EXTENSIONS.some((ext) => file.endsWith(ext));

let socket;
let nextId = 0;
const pending = new Map();

/** One JSON-RPC call to the game; resolves with its result, rejects on error or timeout. */
function call(method, params) {
  if (!socket || socket.readyState !== socket.OPEN) return Promise.reject(new Error("game not connected"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function push(rel) {
  const file = path.join(DIST, rel);
  if (!allowed(rel) || !fs.existsSync(file)) return Promise.resolve();
  return call("pushFile", { server: "home", filename: gamePath(rel), content: fs.readFileSync(file, "utf8") }).catch((e) =>
    log(`push ${rel} failed: ${e.message}`)
  );
}

function listDist(dir = DIST, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listDist(path.join(dir, entry.name), rel));
    else if (allowed(rel)) out.push(rel);
  }
  return out;
}

async function pushAll() {
  const files = listDist();
  await Promise.all(files.map(push));
  log(`pushed ${files.length} file(s) from ${DIST}/`);
}

// Last content written per mirrored file, so unchanged files aren't rewritten.
const mirrored = new Map();
let pulling = false;
let firstPull = true;

async function pull() {
  if (pulling || !socket) return;
  pulling = true;
  try {
    const names = (await call("getFileNames", { server: "home" })).map(relPath);
    const wanted = names.filter((n) => PULL_PREFIXES.some((p) => n.startsWith(p)) && !PULL_SKIP.some((p) => n.startsWith(p)));
    let changed = 0;
    for (const rel of wanted) {
      const content = await call("getFile", { server: "home", filename: gamePath(rel) });
      if (mirrored.get(rel) === content) continue;
      const target = path.join(MIRROR, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      mirrored.set(rel, content);
      changed++;
    }
    fs.mkdirSync(MIRROR, { recursive: true });
    fs.writeFileSync(path.join(MIRROR, ".last_pull"), `${new Date().toISOString()} ${wanted.length} file(s), ${changed} changed\n`);
    // Routine pulls stay quiet (game/.last_pull records each); only the
    // first after a connect is logged.
    if (firstPull) log(`mirroring ${wanted.length} file(s) into ${MIRROR}/`);
    firstPull = false;
  } catch (e) {
    log(`pull failed: ${e.message}`);
  } finally {
    pulling = false;
  }
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  if (socket) socket.close();
  socket = ws;
  firstPull = true;
  log("game connected");
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    clearTimeout(req.timer);
    if (msg.error) req.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
    else req.resolve(msg.result);
  });
  ws.on("close", () => {
    if (socket === ws) socket = undefined;
    log("game disconnected");
  });

  (async () => {
    if (config.definitionFile?.update) {
      try {
        // A real definitions file is hundreds of KB; anything tiny is a
        // broken or fake answer and must not replace the working one.
        const defs = await call("getDefinitionFile");
        if (typeof defs === "string" && defs.length > 10_000) fs.writeFileSync(DEFS_PATH, defs);
        else log(`ignored a ${typeof defs === "string" ? defs.length : 0}-byte definition file`);
      } catch (e) {
        log(`definition file failed: ${e.message}`);
      }
    }
    await pushAll();
    await pull();
  })();
});

chokidar.watch(DIST, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200 } })
  .on("add", (file) => push(path.relative(DIST, file)))
  .on("change", (file) => push(path.relative(DIST, file)))
  .on("unlink", (file) => {
    const rel = path.relative(DIST, file);
    if (config.allowDeletingFiles && allowed(rel)) call("deleteFile", { server: "home", filename: gamePath(rel) }).catch(() => {});
  });

setInterval(pull, PULL_INTERVAL_MS);
log(`listening on port ${PORT}; pushing ${DIST}/, mirroring ${PULL_PREFIXES.join(", ")} into ${MIRROR}/`);
