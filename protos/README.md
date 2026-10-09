# Protos

Rather than fuss with ports, let's generate all the client/server interactions with port. This will let us automate the client/server generation, streamline clinet interaction, and hopefully make the code simpler/boring.


Intresting notes:
1. In BitBurner Netscript ports are universal, so communication must be unique:
   * **Requirement**: Generation must be aware of the current protos 
BitBurner's NetScript ports are universal. They do not require an address, and are shared across every host in the game rather than scoped to whichever host a script runs on — so port numbers need to stay unique project-wide, not just within one service.

## How client connections work

Every generated service gets one well-known **service port** — the shared inbox every client writes requests into. It's auto-assigned by `build.mjs` from `protos/port_registry.json` the first time a service is generated, and persisted there so regenerating the client/server code never reassigns an already-running service's port.

The server (`NewServer`/`Serve()` in `system/rpc/rpc.ts`) is the only thing that reads from the service port. It loops forever, draining requests one at a time (`ns.readPort`), dispatches each to the matching handler, and writes the reply back to whichever port *that specific request* asked for — the server never has a fixed idea of who's calling.

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

`Codes` (in `system/rpc/rpc.ts`) reuses gRPC's status code vocabulary (https://grpc.io/docs/guides/status-codes/) instead of a bespoke one — the same `NOT_FOUND` means "this service/method doesn't exist" *or* "the record you asked about doesn't exist," the same way HTTP's 404 covers both. A handler can throw `new rpc.RpcError(status, message)` to set any status directly; anything else it throws becomes `INTERNAL`.

### One `.proto` file, multiple services

A single `.proto` file may declare more than one `service` block; the generator renders all of them into one output file in a single pass, deduplicating any messages/enums shared between them. Each service still gets its own port (registered under `package.ServiceName` in `port_registry.json`), and its own `New{{ServiceName}}Client`/`Register{{ServiceName}}` pair — the constructor is always namespaced by service name (not a bare `NewClient`) specifically so two services in the same file, or even the same package, never collide.
## Best practices: services for distributed work

Ports are global, so a generated client reaches its service on whatever server it runs on. That makes
a service the way to spread work across servers. Lessons from splitting the faction daemon
(`docs/faction_split.md` on branch `faction-split`):

- **Make a service of anything heavy in RAM.** The game charges each script for every function it
  references, so a large daemon can't start until some server is big enough. Split the game calls into
  services of 32 GB or less, each running on any server with room, and keep the decisions in a small
  client. The faction daemon went from 100.8 GB to a 6.7 GB planner plus four services of 17–30 GB.
- **One service can serve many clients.** A service pays for its functions once, so a daemon that only
  needs reads another service already offers can drop those functions. That's worth it for expensive
  functions (≥ ~2 GB); for cheap ones the RPC plumbing costs more than it saves.
- **RAM spreads, CPU doesn't.** Every script shares the browser's single JavaScript thread, so a service
  on another server holds RAM there but computes on the same thread. For CPU-heavy work (Go move search),
  put a Web Worker behind the service (`tools/web_worker_probe.ts` showed workers run off the main
  thread).
- **Keep services dumb.** No decisions, config or state files: each request is one or a few game calls.
  Then nothing needs syncing with home, and any server works.
- **Snapshot, then act.** A client reads one snapshot per service per tick and decides synchronously from
  it, so RPC latency (~10–50 ms per call) is paid once per tick, not in a loop. If a snapshot fails, skip
  the tick; never act on half a view.
- **Pass the deadline.** Every call takes the caller's `Deadline`, so a slow service costs the caller a
  tick, not a hang.
- **Mind the game's RAM rules:**
  - Names are charged by bare identifier, whatever object they belong to, so don't name fields or
    methods after game functions. A field called `run` or `share` costs RAM wherever it's read.
  - `import * as m` reaches everything in `m`.
  - A main script pays for all its own top-level functions; imported modules only for what's reached.
- **Measure before shipping.** `node build/ram_estimate.mjs [--root dist] --detail <script.js>` sizes a
  script the way the game does, offline, using the price list from `tools/ram_costs.js`.

## Conventions: one service per proto, a request and response per method

- **One service per `.proto`** (`factions/rpc/standing.proto` holds `StandingService`), in its own
  `package` (port registry keys are `package.Service`). The generated module is named after the file.
- **Every method has its own request and response** (`GetStandingRequest` / `GetStandingResponse`),
  even when they're empty, so each method's API can change on its own. Name methods for what they do
  (`GetStanding`, not `Snapshot`).
- **Shared building blocks go in a types file** (`factions/rpc/faction_types.proto`: enums and messages
  responses embed), imported with `import "faction_types.proto";` and referred to by package
  (`faction_types.Standing`). The generator emits TypeScript imports for them instead of copies.
- **A service is its proto plus its handlers:** `services/<stem>_handlers.ts` exporting
  `create<Name>Handlers(ns)`. The generator then emits the main script (`services/<stem>_service.ts`)
  and the folder's deploy list (`services/deploy.ts`, `<DOMAIN>_SERVICE_SCRIPTS`), which boot, the
  reloader, status and the bootstrap use.
- **Keep each service small enough to bin-pack** onto the servers a BitNode starts with (16 GB is common):
  `node build/ram_estimate.mjs --root dist --detail factions/services/<stem>_service.js`.
