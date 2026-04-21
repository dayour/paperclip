import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    server: {
      deps: {
        // Externalize drizzle-orm and related ESM-only packages so vite-node
        // loads them via native import() rather than require(). Without this,
        // Node >=22's require(esm) detects drizzle-orm's circular dependency
        // and throws ERR_REQUIRE_CYCLE_MODULE.
        external: ["drizzle-orm", /drizzle-orm/, /node_modules\/drizzle-orm/],
      },
    },
  },
});
