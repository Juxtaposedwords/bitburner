import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./src/tsconfig.json"] })],
  test: {
    include: ["src/**/*_test.ts"],
  },
});
