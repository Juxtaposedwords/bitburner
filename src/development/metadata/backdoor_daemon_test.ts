import { describe, expect, it } from "vitest";
import { selectBackdoorTargets } from "development/metadata/backdoor_daemon";
import * as server_metadata_pb from "development/metadata/server_metadata";

const metadata = (hostname: string, overrides: Partial<server_metadata_pb.Metadata> = {}): server_metadata_pb.Metadata => ({
  hostname,
  ...overrides,
});

const rootedHackableNpc = (hostname: string, backdoorInstalled = false): server_metadata_pb.Metadata =>
  metadata(hostname, {
    rootStatus: server_metadata_pb.RootStatus.ROOTED,
    hackStatus: server_metadata_pb.HackStatus.HACKABLE,
    kind: server_metadata_pb.ServerKind.NPC,
    backdoorInstalled,
  });

describe("selectBackdoorTargets", () => {
  it("keeps rooted, hackable NPC servers that aren't already backdoored", () => {
    const target = rootedHackableNpc("a");
    expect(selectBackdoorTargets([target])).toEqual([target]);
  });

  it("excludes servers that are already backdoored", () => {
    expect(selectBackdoorTargets([rootedHackableNpc("a", true)])).toEqual([]);
  });

  it("excludes servers that aren't rooted yet", () => {
    const notRooted = metadata("a", {
      rootStatus: server_metadata_pb.RootStatus.ROOTABLE,
      hackStatus: server_metadata_pb.HackStatus.HACKABLE,
      kind: server_metadata_pb.ServerKind.NPC,
    });
    expect(selectBackdoorTargets([notRooted])).toEqual([]);
  });

  it("excludes rooted servers above the player's current hacking level - rootStatus alone doesn't imply hackable", () => {
    const tooHighLevel = metadata("a", {
      rootStatus: server_metadata_pb.RootStatus.ROOTED,
      hackStatus: server_metadata_pb.HackStatus.UNHACKABLE,
      kind: server_metadata_pb.ServerKind.NPC,
    });
    expect(selectBackdoorTargets([tooHighLevel])).toEqual([]);
  });

  it("excludes home, hacknet, and purchased servers even if rooted and hackable", () => {
    const home = metadata("home", {
      rootStatus: server_metadata_pb.RootStatus.ROOTED,
      hackStatus: server_metadata_pb.HackStatus.HACKABLE,
      kind: server_metadata_pb.ServerKind.HOME,
    });
    const hacknet = metadata("hacknet-server-0", {
      rootStatus: server_metadata_pb.RootStatus.ROOTED,
      hackStatus: server_metadata_pb.HackStatus.HACKABLE,
      kind: server_metadata_pb.ServerKind.HACKNET,
    });
    const purchased = metadata("purchased-1", {
      rootStatus: server_metadata_pb.RootStatus.ROOTED,
      hackStatus: server_metadata_pb.HackStatus.HACKABLE,
      kind: server_metadata_pb.ServerKind.PURCHASED,
    });

    expect(selectBackdoorTargets([home, hacknet, purchased])).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(selectBackdoorTargets([])).toEqual([]);
  });
});
