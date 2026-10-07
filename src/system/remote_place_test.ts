import { describe, expect, it } from "vitest";
import { pickDaemonHost } from "system/remote_place";

describe("pickDaemonHost", () => {
  const room = (host: string, maxRam: number, usedRam = 0, daemonHost = false) => ({ host, maxRam, usedRam, daemonHost });

  it("packs onto a daemon host with room before taking a fresh server", () => {
    expect(pickDaemonHost([room("silver-helix", 64, 30, true), room("zer0", 32)], 25)).toEqual({ host: "silver-helix", fresh: false });
  });

  it("takes the smallest fresh server that fits, leaving the big ones to workers", () => {
    expect(pickDaemonHost([room("silver-helix", 64), room("zer0", 32), room("n00dles", 4)], 29.7)).toEqual({ host: "zer0", fresh: true });
  });

  it("finds nothing when no server is big enough", () => {
    expect(pickDaemonHost([room("zer0", 32), room("omega-net", 32, 10, true)], 40)).toBeUndefined();
  });
});
