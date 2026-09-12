import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(packageRoot, "sources"),
        },
    },
    test: {
        environment: "node",
        // Each Windows worker loads all vendor SDKs; limit contention so protocol
        // timing assertions measure the transport, not worker startup starvation.
        ...(process.platform === "win32" ? { maxWorkers: 2, minWorkers: 1 } : {}),
        include: ["tests/**/*.test.ts", "tests/vendors/captureGrok.ts"],
        exclude: ["tests/**/*.live.test.ts"],
    },
});
