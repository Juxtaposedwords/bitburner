import { describe, expect, it } from "vitest";
import { getCode, getMessage, RpcResponse } from "development/libraries/rpc";
import { Codes } from "development/libraries/status";

describe("getCode", () => {
  it("returns the response's status", () => {
    const res: RpcResponse<{ hostname: string }> = { status: Codes.NOT_FOUND, error: "unknown hostname" };

    expect(getCode(res)).toBe(Codes.NOT_FOUND);
  });
});

describe("getMessage", () => {
  it("returns the error detail when present", () => {
    const res: RpcResponse<unknown> = { status: Codes.NOT_FOUND, error: "unknown hostname 'n00dles'" };

    expect(getMessage(res)).toBe("unknown hostname 'n00dles'");
  });

  it("returns undefined for a successful response", () => {
    const res: RpcResponse<{ ok: true }> = { status: Codes.OK, data: { ok: true } };

    expect(getMessage(res)).toBeUndefined();
  });
});
