import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

// Plays our Go strategies against the game's real AI (goAI.ts), from a
// sparse clone of bitburner-src at ../../vendor/bitburner-src (see
// gosim/README.md). Run: npx vitest run --config gosim/vitest.config.ts
const vendor = path.resolve(__dirname, "../../vendor/bitburner-src/src");
const stubs = path.resolve(__dirname, "stubs");

export default defineConfig({
  root: path.resolve(__dirname, ".."),
  plugins: [tsconfigPaths({ projects: ["./src/tsconfig.json"] })],
  resolve: {
    alias: [
      // Our own modules, as src/tsconfig.json maps them for files under src/.
      { find: /^(go|system)\/(.*)$/, replacement: path.resolve(__dirname, "../src") + "/$1/$2" },
      { find: "@enums", replacement: path.join(stubs, "enums.ts") },
      { find: "@player", replacement: path.join(stubs, "player.ts") },
      { find: /^.*\/utils\/Utility$/, replacement: path.join(stubs, "utility.ts") },
      { find: /^\.\.\/boardAnalysis\/scoring$/, replacement: path.join(stubs, "scoring.ts") },
      { find: /^\.\/scoring$/, replacement: path.join(stubs, "scoring.ts") },
      { find: /^.*\/helpers\/exceptionAlert$/, replacement: path.join(stubs, "exceptionAlert.ts") },
    ],
  },
  test: {
    include: ["gosim/**/*_bench.ts"],
    testTimeout: 3_600_000,
  },
});
