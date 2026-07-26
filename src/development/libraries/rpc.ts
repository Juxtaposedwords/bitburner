import { NS } from "@ns";

export interface RpcEnvelope<T = any> {
    service: string;
    method: string;
    replyPort: number;
    payload: T;
}

export interface RpcResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
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
     * Serves forever. `onTick`, if given, runs once per poll iteration on this
     * same loop — Bitburner forbids concurrent NS calls from one script, so
     * callers needing periodic work (e.g. a flush timer) must hook in here
     * rather than run their own `while (true) { await ns.sleep(...) }` loop
     * alongside `Serve()`.
     */
    Serve(onTick?: () => void | Promise<void>): Promise<void>;
}

export function NewServer(ns: NS, listenPort: number): RpcServer {
    const serviceRegistry = new Map<string, Record<string, Function>>();

    return {
        registerService: (serviceName: string, handlers: Record<string, Function>) => {
            serviceRegistry.set(serviceName, handlers);
        },

        Serve: async (onTick?: () => void | Promise<void>) => {
            ns.print(`[RPC Node] Listening on port ${listenPort}...`);
            while (true) {
                const data = ns.readPort(listenPort);
                if (data !== "NULL PORT DATA") {
                    let replyPort: number | null = null;
                    try {
                        const envelope: RpcEnvelope = JSON.parse(data as string);
                        replyPort = envelope.replyPort;

                        const serviceHandlers = serviceRegistry.get(envelope.service);
                        if (!serviceHandlers) throw new Error(`Service '${envelope.service}' not registered.`);

                        const handler = serviceHandlers[envelope.method];
                        if (!handler) throw new Error(`Method '${envelope.method}' not found on '${envelope.service}'.`);

                        const result = await handler(envelope.payload);
                        const response: RpcResponse = { success: true, data: result };
                        ns.writePort(replyPort, JSON.stringify(response));
                    } catch (err: any) {
                        ns.print(`[RPC Error]: ${err}`);
                        if (replyPort !== null) {
                            const response: RpcResponse = { success: false, error: err?.message || String(err) };
                            ns.writePort(replyPort, JSON.stringify(response));
                        }
                    }
                }
                if (onTick) await onTick();
                await ns.asleep(10);
            }
        }
    };
}
