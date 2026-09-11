import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        environment: "node",
        include: ["sources/**/*.live.test.ts"],
    },
});
