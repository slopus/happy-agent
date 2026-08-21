import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["sources/**/*.live.test.ts"],
    },
});
