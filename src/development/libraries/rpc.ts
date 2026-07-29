import { NS } from "@ns";
import { Codes } from "development/libraries/status";

export { Codes } from "development/libraries/status";

export interface RpcEnvelope<T = any> {
    service: string;
    method: string;
    replyPort: number;
    payload: T;
}

// Module-level, not per-client: every generated client for every service
// imports this same module, so one script using several different clients
// concurrently still draws from a single shared counter. A per-client
// counter would let two different clients' first calls both land on the
// same reply port.
let replyPortCounter = 0;

/**
 * A reply port unique to this specific call — not just to this process.
 * `ns.pid` alone (this project's original scheme) is unique per-process, but
 * not per-call: two concurrent calls from the same script, even to
 * different clients, would otherwise compute the identical port and race to
 * read each other's replies. Multiplying (rather than adding a fixed
 * offset) reserves the low digits for the counter, so no combination of
 * pid and counter can land on a low, statically-assigned service port.
 */
export function nextReplyPort(ns: NS): number {
    return ns.pid * 10000 + (replyPortCounter++ % 10000);
}

export interface RpcResponse<T = any> {
    status: Codes;
    data?: T;
    error?: string;
}

/** The status code out of an RpcResponse — mirrors gRPC/Go's `status.Code(err)`. */
export function getCode(res: RpcResponse<unknown>): Codes {
    return res.status;
}

/** The detail message out of an RpcResponse, if the status wasn't OK. */
export function getMessage(res: RpcResponse<unknown>): string | undefined {
    return res.error;
}

/** Throw from any handler to set the reply's transport-level status code directly. */
export class RpcError extends Error {
    constructor(public readonly status: Codes, message: string) {
        super(message);
    }
}

/**
 * Polls `condition` until it's true or `deadline` (a Date.now()-based
 * timestamp) passes, sleeping with exponential backoff between checks so
 * callers waiting on port contention or a reply don't busy-poll every 10ms
 * for the full timeout. Returns whether `condition` became true in time.
 *
 * Uses `ns.asleep` (not `ns.sleep`) so a script can have several RPC calls
 * in flight at once — e.g. fan out with `Promise.all(hosts.map(client.Call))`
 * — without tripping Bitburner's "concurrent Netscript calls" error.
 */
export async function pollWithBackoff(
    ns: NS,
    condition: () => boolean,
    deadline: number,
    delayMs = 10,
    maxDelayMs = 200
): Promise<boolean> {
    while (!condition()) {
        if (Date.now() > deadline) return false;
        await ns.asleep(delayMs);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
    return true;
}

export interface RpcServer {
    registerService(serviceName: string, handlers: Record<string, Function>): void;
    /**
     * Registers work that runs forever alongside the request loop, on its
     * own interval — call this as many times as you want, for as many
     * independent background tasks as you want. Each one is its own
     * `while (true) { task(); asleep(intervalMs) }` loop, run concurrently
     * (via `ns.asleep`, which — unlike `ns.sleep` — doesn't trip Bitburner's
     * "concurrent Netscript calls" error) rather than sharing one slot in
     * the request loop, so a slow or frequent task never delays another.
     */
    addBackgroundTask(task: () => void | Promise<void>, intervalMs: number): void;
    /** Serves forever: the request loop, plus every registered background task, concurrently. */
    Serve(): Promise<void>;
}

/**
 * Clears `listenPort` before returning, so callers never need to remember
 * to do it themselves — a fresh server should never pick up stale requests
 * left over from a previous run.
 */
export function NewServer(ns: NS, listenPort: number): RpcServer {
    ns.clearPort(listenPort);
    const serviceRegistry = new Map<string, Record<string, Function>>();
    const backgroundTasks: { task: () => void | Promise<void>; intervalMs: number }[] = [];

    const serveRequests = async (): Promise<void> => {
        ns.print(`[RPC Node] Listening on port ${listenPort}...`);
        while (true) {
            const data = ns.readPort(listenPort);
            if (data !== "NULL PORT DATA") {
                let replyPort: number | null = null;
                try {
                    const envelope: RpcEnvelope = JSON.parse(data as string);
                    replyPort = envelope.replyPort;

                    const serviceHandlers = serviceRegistry.get(envelope.service);
                    if (!serviceHandlers) throw new RpcError(Codes.UNIMPLEMENTED, `Service '${envelope.service}' not registered.`);

                    const handler = serviceHandlers[envelope.method];
                    if (!handler) throw new RpcError(Codes.UNIMPLEMENTED, `Method '${envelope.method}' not found on '${envelope.service}'.`);

                    const result = await handler(envelope.payload);
                    const response: RpcResponse = { status: Codes.OK, data: result };
                    ns.writePort(replyPort, JSON.stringify(response));
                } catch (err: any) {
                    ns.print(`[RPC Error]: ${err}`);
                    if (replyPort !== null) {
                        const status = err instanceof RpcError ? err.status : Codes.INTERNAL;
                        const response: RpcResponse = { status, error: err?.message || String(err) };
                        ns.writePort(replyPort, JSON.stringify(response));
                    }
                }
            }
            await ns.asleep(10);
        }
    };

    const runBackgroundTask = async ({ task, intervalMs }: { task: () => void | Promise<void>; intervalMs: number }): Promise<void> => {
        while (true) {
            await task();
            await ns.asleep(intervalMs);
        }
    };

    return {
        registerService: (serviceName: string, handlers: Record<string, Function>) => {
            serviceRegistry.set(serviceName, handlers);
        },

        addBackgroundTask: (task: () => void | Promise<void>, intervalMs: number) => {
            backgroundTasks.push({ task, intervalMs });
        },

        Serve: async () => {
            await Promise.all([serveRequests(), ...backgroundTasks.map(runBackgroundTask)]);
        }
    };
}
