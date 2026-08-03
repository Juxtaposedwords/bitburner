import { describe, expect, it } from "vitest";
import { buildDump } from "tools/dump_logs";

describe("buildDump", () => {
  it("emits a header and every line for a file under the tail limit", () => {
    const out = buildDump([{ path: "/var/log/home/Rooter.txt", content: "line1\nline2\n" }], 200);

    expect(out).toBe("=== /var/log/home/Rooter.txt (2 lines) ===\nline1\nline2");
  });

  it("keeps only the last N lines and notes how many were omitted", () => {
    const content = ["a", "b", "c", "d", "e"].join("\n");

    const out = buildDump([{ path: "/var/log/home/Rooter.txt", content }], 2);

    expect(out).toBe("=== /var/log/home/Rooter.txt (2 of 5 lines) ===\nd\ne");
  });

  it("keeps every line when tailLines is Infinity", () => {
    const content = ["a", "b", "c"].join("\n");

    const out = buildDump([{ path: "/var/log/home/Rooter.txt", content }], Infinity);

    expect(out).toBe("=== /var/log/home/Rooter.txt (3 lines) ===\na\nb\nc");
  });

  it("marks an empty file explicitly rather than leaving a blank section", () => {
    const out = buildDump([{ path: "/var/log/home/Empty.txt", content: "" }], 200);

    expect(out).toBe("=== /var/log/home/Empty.txt (0 lines) ===\n(empty)");
  });

  it("joins multiple files with a blank line between sections", () => {
    const out = buildDump(
      [
        { path: "/var/log/home/A.txt", content: "a1" },
        { path: "/var/log/home/B.txt", content: "b1" },
      ],
      200
    );

    expect(out).toBe("=== /var/log/home/A.txt (1 lines) ===\na1\n\n=== /var/log/home/B.txt (1 lines) ===\nb1");
  });
});
