import { describe, expect, it } from "vitest";
import { applyConfigEdit } from "tools/set_config";

describe("applyConfigEdit", () => {
  const raw = JSON.stringify({ reserveMoney: 5, hashSpendPriority: ["Sell for Money"] });

  it("sets a JSON value and keeps other keys", () => {
    expect(JSON.parse(applyConfigEdit(raw, "hashSpendPriority", '["Improve Studying"]'))).toEqual({
      reserveMoney: 5,
      hashSpendPriority: ["Improve Studying"],
    });
  });

  it("parses numbers and booleans, keeps other text as a string", () => {
    expect(JSON.parse(applyConfigEdit(raw, "reserveMoney", "1e9")).reserveMoney).toBe(1e9);
    expect(JSON.parse(applyConfigEdit(raw, "enabled", "false")).enabled).toBe(false);
    expect(JSON.parse(applyConfigEdit(raw, "hashDrainUpgrade", "Sell for Money")).hashDrainUpgrade).toBe("Sell for Money");
  });

  it("unsets a key so the daemon default applies", () => {
    expect(JSON.parse(applyConfigEdit(raw, "hashSpendPriority", undefined))).toEqual({ reserveMoney: 5 });
  });

  it("starts from empty for a missing file", () => {
    expect(JSON.parse(applyConfigEdit("", "enabled", "true"))).toEqual({ enabled: true });
  });

  it("throws on corrupt JSON rather than overwriting it", () => {
    expect(() => applyConfigEdit("{bad", "enabled", "true")).toThrow();
  });
});
