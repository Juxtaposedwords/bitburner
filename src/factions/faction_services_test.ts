import { NS } from "@ns";
import { afterEach, describe, expect, it } from "vitest";
import * as rpc from "system/rpc/rpc";
import * as catalog_pb from "factions/rpc/aug_catalog";
import * as detail_pb from "factions/rpc/aug_detail";
import * as standing_pb from "factions/rpc/standing";
import * as invite_pb from "factions/rpc/invite";
import * as work_pb from "factions/rpc/work";
import * as job_pb from "factions/rpc/job";
import * as crime_info_pb from "factions/rpc/crime_info";
import * as crime_pb from "factions/rpc/crime";
import * as buy_pb from "factions/rpc/aug_buy";
import * as install_pb from "factions/rpc/install";
import * as home_ram_pb from "factions/rpc/home_ram";
import { createAugCatalogHandlers } from "factions/services/aug_catalog_handlers";
import { createAugDetailHandlers } from "factions/services/aug_detail_handlers";
import { createStandingHandlers } from "factions/services/standing_handlers";
import { createInviteHandlers } from "factions/services/invite_handlers";
import { createWorkHandlers } from "factions/services/work_handlers";
import { createJobHandlers } from "factions/services/job_handlers";
import { createCrimeInfoHandlers } from "factions/services/crime_info_handlers";
import { createCrimeHandlers } from "factions/services/crime_handlers";
import { createAugBuyHandlers } from "factions/services/aug_buy_handlers";
import { createInstallHandlers } from "factions/services/install_handlers";
import { createHomeRamHandlers } from "factions/services/home_ram_handlers";
import { factionClients, FactionClients, fetchView, fetchWork, isFailure, succeeded } from "factions/faction_gateway";
import { FactionView } from "factions/faction_view";
import { deadlineIn } from "system/deadline";

// A tiny game: ports shared by every fake script (they're global in the
// game too), and just enough of ns.singularity for the handlers.
type Game = {
  ports: Map<number, string[]>;
  calls: string[];
  stopped: boolean;
};

function fakeNs(game: Game, pid: number): NS {
  const port = (n: number): string[] => game.ports.get(n) ?? (game.ports.set(n, []), game.ports.get(n) as string[]);
  const call = (name: string, result: unknown) => (...args: unknown[]) => {
    game.calls.push(`${name}(${args.join(",")})`);
    return result;
  };
  const stats: Record<string, Record<string, number>> = { BitWire: { hacking: 1.05 }, QLink: { hacking: 1.75, hacking_chance: 1.3 } };
  return {
    pid,
    readPort: (n: number) => port(n).shift() ?? "NULL PORT DATA",
    writePort: (n: number, v: string) => (port(n).push(v), null),
    tryWritePort: (n: number, v: string) => (port(n).push(v), true),
    peek: (n: number) => port(n)[0] ?? "NULL PORT DATA",
    clearPort: (n: number) => void game.ports.set(n, []),
    asleep: (ms: number) => (game.stopped ? Promise.reject(new Error("stopped")) : new Promise((r) => setTimeout(r, Math.min(ms, 5)))),
    print: () => undefined,
    getFavorToDonate: () => 150,
    getServerMoneyAvailable: () => 1e12,
    getServerMaxRam: () => 64,
    enums: { CrimeType: { mug: "Mug", homicide: "Homicide" } },
    stock: { hasTixApiAccess: () => false },
    singularity: {
      getAugmentationsFromFaction: (f: string) => (f === "Netburners" ? ["BitWire"] : f === "Daedalus" ? ["QLink"] : []),
      getAugmentationPrice: (n: string) => (n === "QLink" ? 1e12 : 1e7),
      getAugmentationRepReq: (n: string) => (n === "QLink" ? 875e3 : 3750),
      getAugmentationPrereq: () => [],
      getAugmentationStats: (n: string) => stats[n] ?? {},
      getOwnedAugmentations: (queued: boolean) => (queued ? ["BitWire", "NeuroFlux Governor"] : ["NeuroFlux Governor"]),
      getFactionRep: (f: string) => (f === "Netburners" ? 5000 : 0),
      getFactionFavor: (f: string) => (f === "Netburners" ? 160 : 0),
      getCompanyRep: () => 1234,
      checkFactionInvitations: () => ["CyberSec"],
      getFactionInviteRequirements: () => [{ type: "money", money: 1e6 }],
      getCurrentWork: () => ({ type: "FACTION", factionName: "Netburners", factionWorkType: "hacking" }),
      getFactionWorkTypes: () => ["hacking"],
      joinFaction: call("joinFaction", true),
      workForFaction: call("workForFaction", true),
      getCrimeStats: (c: string) => ({ karma: c === "Homicide" ? 3 : 0.25, time: c === "Homicide" ? 3000 : 4000, kills: c === "Homicide" ? 1 : 0 }),
      getCrimeChance: (c: string) => (c === "Homicide" ? 0.4 : 0.9),
      commitCrime: call("commitCrime", 3000),
      purchaseAugmentation: call("purchaseAugmentation", true),
      donateToFaction: call("donateToFaction", true),
      getUpgradeHomeRamCost: () => 1e15,
      upgradeHomeRam: call("upgradeHomeRam", true),
    },
  } as unknown as NS;
}

let game: Game;

function startServices(): void {
  game = { ports: new Map(), calls: [], stopped: false };
  const serve = (port: number, register: (server: rpc.RpcServer) => void): void => {
    const server = rpc.NewServer(fakeNs(game, port), port);
    register(server);
    server.Serve().catch(() => undefined);
  };
  const svc = fakeNs(game, 1);
  serve(catalog_pb.AugCatalogServicePort, (s) => catalog_pb.RegisterAugCatalogService(s, createAugCatalogHandlers(svc)));
  serve(detail_pb.AugDetailServicePort, (s) => detail_pb.RegisterAugDetailService(s, createAugDetailHandlers(svc)));
  serve(standing_pb.StandingServicePort, (s) => standing_pb.RegisterStandingService(s, createStandingHandlers(svc)));
  serve(invite_pb.InviteServicePort, (s) => invite_pb.RegisterInviteService(s, createInviteHandlers(svc)));
  serve(work_pb.WorkServicePort, (s) => work_pb.RegisterWorkService(s, createWorkHandlers(svc)));
  serve(job_pb.JobServicePort, (s) => job_pb.RegisterJobService(s, createJobHandlers(svc)));
  serve(crime_info_pb.CrimeInfoServicePort, (s) => crime_info_pb.RegisterCrimeInfoService(s, createCrimeInfoHandlers(svc)));
  serve(crime_pb.CrimeServicePort, (s) => crime_pb.RegisterCrimeService(s, createCrimeHandlers(svc)));
  serve(buy_pb.AugBuyServicePort, (s) => buy_pb.RegisterAugBuyService(s, createAugBuyHandlers(svc)));
  serve(install_pb.InstallServicePort, (s) => install_pb.RegisterInstallService(s, createInstallHandlers(svc)));
  serve(home_ram_pb.HomeRamServicePort, (s) => home_ram_pb.RegisterHomeRamService(s, createHomeRamHandlers(svc)));
}

afterEach(() => {
  if (game) game.stopped = true;
});

const request = { joined: ["Netburners"], requirementFactions: ["Daedalus"], offerFactions: ["Daedalus"], companies: ["ECorp"] };

describe("the faction daemon and its services, over ports", () => {
  it("builds the tick's view from the services", async () => {
    startServices();
    const c = factionClients(fakeNs(game, 42));
    const deadline = deadlineIn(2000);
    const work = await fetchWork(c, request, deadline);
    if (isFailure(work)) throw new Error(work.call);
    expect(work.invites.invitations).toEqual(["CyberSec"]);

    const view = await fetchView(c, request, work, deadline);
    if (isFailure(view)) throw new Error(view.call);
    expect(view.catalogFor(["Netburners"]).map((a) => a.name)).toEqual(["BitWire"]);
    expect(view.offered("Daedalus")).toEqual(["QLink"]);
    expect(view.statsOf("QLink")).toEqual({ hacking: 1.75, hacking_chance: 1.3 });
    expect(view.repOf("Netburners")).toBe(5000);
    expect(view.favorOf("Netburners")).toBe(160);
    expect(view.favorToDonate).toBe(150);
    expect(view.pending()).toEqual(["BitWire"]);
    expect(view.installed).toEqual(["NeuroFlux Governor"]);
    expect(view.companyRepOf("ECorp")).toBe(1234);
    expect(view.requirementsOf("Daedalus")).toEqual([{ type: "money", money: 1e6 }]);
    expect(view.currentWork).toMatchObject({ type: "FACTION", factionName: "Netburners" });
    expect(view.workTypesOf("Netburners")).toEqual(["hacking"]);
    expect(view.crimeOf("Homicide")).toMatchObject({ karma: 3, timeMs: 3000, kills: 1, chance: 0.4 });
  });

  it("acts through the services", async () => {
    startServices();
    const c = factionClients(fakeNs(game, 43));
    const deadline = deadlineIn(2000);
    expect(succeeded(await c.invite.Join({ faction: "CyberSec" }, deadline))).toBe(true);
    expect(succeeded(await c.work.WorkForFaction({ faction: "Netburners", workType: "hacking" }, deadline))).toBe(true);
    await c.crime.CommitCrime({ crime: "Homicide" }, deadline);
    expect(succeeded(await c.buy.Purchase({ faction: "Netburners", augmentation: "BitWire" }, deadline))).toBe(true);
    expect(succeeded(await c.buy.Donate({ faction: "Netburners", amount: 5e9 }, deadline))).toBe(true);
    expect(game.calls).toEqual([
      "joinFaction(CyberSec)",
      "workForFaction(Netburners,hacking)",
      "commitCrime(Homicide)",
      "purchaseAugmentation(Netburners,BitWire)",
      "donateToFaction(Netburners,5000000000)",
    ]);
  });

  it("reports a service that doesn't answer as a failure, not a half view", async () => {
    game = { ports: new Map(), calls: [], stopped: false };
    const c = factionClients(fakeNs(game, 44));
    const work = await fetchWork(c, request, deadlineIn(50));
    expect(isFailure(work)).toBe(true);
  });
});

describe("FactionView", () => {
  it("defaults what wasn't asked about", () => {
    const view = new FactionView({ standing: {}, catalog: {}, details: {}, invites: {}, work: { currentWorkJson: "null" } });
    expect(view.offered("Nobody")).toEqual([]);
    expect(view.repOf("Nobody")).toBe(0);
    expect(view.requirementsOf("Nobody")).toEqual([]);
    expect(view.currentWork).toBeNull();
    expect(view.favorToDonate).toBe(Infinity);
  });
});

describe("in-process clients (no ports, no game)", () => {
  const localClients = (ns: NS): FactionClients => ({
    catalog: catalog_pb.NewAugCatalogServiceLocalClient(createAugCatalogHandlers(ns)),
    detail: detail_pb.NewAugDetailServiceLocalClient(createAugDetailHandlers(ns)),
    standing: standing_pb.NewStandingServiceLocalClient(createStandingHandlers(ns)),
    invite: invite_pb.NewInviteServiceLocalClient(createInviteHandlers(ns)),
    work: work_pb.NewWorkServiceLocalClient(createWorkHandlers(ns)),
    job: job_pb.NewJobServiceLocalClient(createJobHandlers(ns)),
    crimeInfo: crime_info_pb.NewCrimeInfoServiceLocalClient(createCrimeInfoHandlers(ns)),
    crime: crime_pb.NewCrimeServiceLocalClient(createCrimeHandlers(ns)),
    buy: buy_pb.NewAugBuyServiceLocalClient(createAugBuyHandlers(ns)),
    install: install_pb.NewInstallServiceLocalClient(createInstallHandlers(ns)),
    homeRam: home_ram_pb.NewHomeRamServiceLocalClient(createHomeRamHandlers(ns)),
  });

  it("give the gateway the same view as the port clients", async () => {
    game = { ports: new Map(), calls: [], stopped: false };
    const c = localClients(fakeNs(game, 7));
    const work = await fetchWork(c, request, deadlineIn(1000));
    if (isFailure(work)) throw new Error(work.call);
    const view = await fetchView(c, request, work, deadlineIn(1000));
    if (isFailure(view)) throw new Error(view.call);
    expect(view.catalogFor(["Netburners", "Daedalus"]).map((a) => a.name)).toEqual(["BitWire", "QLink"]);
    expect(view.offered("Daedalus")).toEqual(["QLink"]);
    expect(game.ports.size).toBe(0);
  });

  it("answer a passed deadline and a throwing handler like the real service", async () => {
    const info = standing_pb.NewStandingServiceLocalClient({
      GetStanding: () => {
        throw new rpc.RpcError(5, "nothing here");
      },
    });
    expect((await info.GetStanding({}, { at: 0 })).status).toBe(4);
    expect(await info.GetStanding({}, 1000)).toMatchObject({ status: 5, error: "nothing here" });
  });
});

describe("pending augmentations no listed faction sells", () => {
  it("are still priced and described (the catalog's second, extraNames round)", async () => {
    startServices();
    const c = factionClients(fakeNs(game, 8));
    // BitWire is pending but only Netburners sells it; ask about Daedalus alone.
    const only = { ...request, joined: ["Daedalus"] };
    const work = await fetchWork(c, only, deadlineIn(2000));
    if (isFailure(work)) throw new Error(work.call);
    const view = await fetchView(c, only, work, deadlineIn(2000));
    if (isFailure(view)) throw new Error(view.call);
    expect(view.pending()).toEqual(["BitWire"]);
    expect(view.statsOf("BitWire")).toEqual({ hacking: 1.05 });
  });
});
