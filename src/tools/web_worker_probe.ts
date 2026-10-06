import { NS } from "@ns";

/**
 * Can heavy computing (IPvGO move choice) leave the game's one thread?
 *
 *   run tools/web_worker_probe.js [--out /var/claude_out/web_worker_probe.txt]
 *
 * Starts a Web Worker from a Blob, has it compute for ~2 seconds, and
 * meanwhile measures event-loop lag (how late 50 ms sleeps wake up) - near
 * zero lag means the work really ran off the game's thread. Also reports
 * this script's RAM: the game charges extra for browser objects, so the
 * probe shows what a Worker-based design would cost. Nothing else is
 * changed.
 */
const LAG_SAMPLES = 30;
const SLEEP_MS = 50;
const WORK_MS = 2000;

type WorkerLike = { postMessage(m: unknown): void; terminate(): void; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null };
type WorkerCtor = new (url: string) => WorkerLike;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const lines = [`script RAM: ${ns.getScriptRam(ns.getScriptName(), "home")} GB`];
  const scope = globalThis as unknown as { Worker?: WorkerCtor; Blob?: new (parts: string[], o: { type: string }) => unknown; URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void } };
  if (!scope.Worker || !scope.Blob || !scope.URL) {
    lines.push("Worker: not available in this environment.");
    finish(ns, lines);
    return;
  }

  // Busy-loops for the given milliseconds, then replies with how many iterations it did.
  const source = `onmessage = (e) => { const end = Date.now() + e.data; let n = 0; while (Date.now() < end) n++; postMessage(n); };`;
  let url: string | undefined;
  let worker: WorkerLike | undefined;
  try {
    url = scope.URL.createObjectURL(new scope.Blob([source], { type: "text/javascript" }));
    worker = new scope.Worker(url);
    const w = worker;
    const started = performance.now();
    const reply = new Promise<number>((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data as number);
      w.onerror = (e) => reject(e);
      w.postMessage(WORK_MS);
    });
    const lags: number[] = [];
    let done = false;
    void reply.then(() => (done = true), () => (done = true));
    while (!done && lags.length < LAG_SAMPLES * 4) {
      const t = performance.now();
      await ns.asleep(SLEEP_MS);
      lags.push(performance.now() - t - SLEEP_MS);
    }
    const iterations = await reply;
    lags.sort((a, b) => a - b);
    const pct = (q: number): number => lags[Math.min(lags.length - 1, Math.floor(q * lags.length))] ?? 0;
    lines.push(
      `Worker: available; computed ${WORK_MS} ms (${iterations.toExponential(2)} iterations), reply after ${(performance.now() - started).toFixed(0)} ms.`,
      `event-loop lag while it computed (${lags.length} samples): median ${pct(0.5).toFixed(0)} ms, p90 ${pct(0.9).toFixed(0)} ms, max ${(lags[lags.length - 1] ?? 0).toFixed(0)} ms ` +
        `- near zero means the work ran off the game's thread.`
    );
  } catch (e) {
    lines.push(`Worker: failed to start or run (${String(e)}).`);
  } finally {
    worker?.terminate();
    if (url) scope.URL.revokeObjectURL(url);
  }
  finish(ns, lines);
}

function finish(ns: NS, lines: string[]): void {
  const outIdx = ns.args.indexOf("--out");
  if (outIdx >= 0) ns.write(String(ns.args[outIdx + 1]), lines.join("\n"), "w");
  else ns.tprint(lines.join("\n"));
}
