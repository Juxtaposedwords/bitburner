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
                await ns.sleep(10);
            }
        }
    };
}
