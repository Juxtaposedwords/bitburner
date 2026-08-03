import { describe, expect, it } from "vitest";
import { selectRootable } from "development/metadata/rooter";
import * as server_metadata_pb from "development/metadata/server_metadata";

const metadata = (hostname: string, overrides: Partial<server_metadata_pb.Metadata> = {}): server_metadata_pb.Metadata => ({
  hostname,
  ...overrides,
});

describe("selectRootable", () => {
  it("keeps only servers with rootStatus === ROOTABLE", () => {
    const rootable = metadata("a", { rootStatus: server_metadata_pb.RootStatus.ROOTABLE });
    const unrootable = metadata("b", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE });
    const rooted = metadata("c", { rootStatus: server_metadata_pb.RootStatus.ROOTED });

    expect(selectRootable([rootable, unrootable, rooted])).toEqual([rootable]);
  });

  it("returns an empty array when nothing is rootable", () => {
    expect(selectRootable([metadata("a", { rootStatus: server_metadata_pb.RootStatus.UNROOTABLE })])).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(selectRootable([])).toEqual([]);
  });
});
