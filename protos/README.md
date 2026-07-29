# Protos

Rather than fuss with ports, let's generate all the client/server interactions with port. This will let us automate the client/server generation, streamline clinet interaction, and hopefully make the code simpler/boring.


Intresting notes:
1. In BitBurner Netscript ports are universal, so communication must be unique:
   * **Requirement**: Generation must be aware of the current protos 
BitBurner's NetScript ports are universal. They do not require an address, and are shared across every host in the game rather than scoped to whichever host a script runs on — so port numbers need to stay unique project-wide, not just within one service.

## How client connections work

Every generated service gets one well-known **service port** — the shared inbox every client writes requests into. It's auto-assigned by `build.mjs` from `protos/port_registry.json` the first time a service is generated, and persisted there so regenerating the client/server code never reassigns an already-running service's port.

The server (`NewServer`/`Serve()` in `development/libraries/rpc.ts`) is the only thing that reads from the service port. It loops forever, draining requests one at a time (`ns.readPort`), dispatches each to the matching handler, and writes the reply back to whichever port *that specific request* asked for — the server never has a fixed idea of who's calling.

Each client call gets its own **reply port**, computed fresh per call by `rpc.nextReplyPort(ns)`:

```ts
replyPort = ns.pid * 10000 + (counter++ % 10000)
```

- `ns.pid` is globally unique across every host in the game (Bitburner guarantees this itself — see `ns.kill(pid)`'s docs), so different scripts' reply ports never collide, with zero coordination needed between them.
- The counter is one module-level variable in `rpc.ts`, shared by every client a script creates — not one per client — so a script juggling several concurrent calls, even to different services, never reuses a reply port mid-flight.
- Multiplying by 10000 (rather than adding a fixed offset) keeps reply ports structurally clear of the low, sequentially-assigned service ports handed out by the registry.

The round trip for one call:
1. Client builds an `RpcEnvelope { service, method, replyPort, payload }` and writes it onto the service port, retrying with backoff (`ns.tryWritePort` + `pollWithBackoff`) if the port's momentarily full.
2. Client polls its own reply port (`ns.peek`) until a response appears or the call times out.
3. Server's `Serve()` loop reads the envelope off the service port, runs the matching handler, and writes an `RpcResponse { status, data?, error? }` to the envelope's `replyPort`.
4. Client reads and parses that response.

Every generated client method resolves to the *whole* `RpcResponse<T>` — it never throws for an RPC-level failure. Callers always get `{ status, data?, error? }` back and check `status` themselves, the same way you'd check an HTTP response's status code rather than assuming 200.

### Status codes

`Codes` (in `development/libraries/rpc.ts`) reuses gRPC's status code vocabulary (https://grpc.io/docs/guides/status-codes/) instead of a bespoke one — the same `NOT_FOUND` means "this service/method doesn't exist" *or* "the record you asked about doesn't exist," the same way HTTP's 404 covers both. A handler can throw `new rpc.RpcError(status, message)` to set any status directly; anything else it throws becomes `INTERNAL`.

### One `.proto` file, multiple services

A single `.proto` file may declare more than one `service` block; the generator renders all of them into one output file in a single pass, deduplicating any messages/enums shared between them. Each service still gets its own port (registered under `package.ServiceName` in `port_registry.json`), and its own `New{{ServiceName}}Client`/`Register{{ServiceName}}` pair — the constructor is always namespaced by service name (not a bare `NewClient`) specifically so two services in the same file, or even the same package, never collide.