import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSourceAdapters } from "../scripts/build-binary.js";

describe("standalone supervisor packaging", () => {
    it("embeds the supervisor resolver used by both sandbox setup and compute", () => {
        const agent = createRequire(new URL("../package.json", import.meta.url));
        const compute = createRequire(agent.resolve("@slopus/happy-agent-compute"));
        const resolverPaths = new Set(
            [agent, compute].map((owner) =>
                realpathSync(
                    join(
                        dirname(owner.resolve("@slopus/happy-agent-supervisor")),
                        "impl/resolveBinaryForTarget.js",
                    ),
                ),
            ),
        );
        const adapters = resolveSourceAdapters({
            arch: "x64",
            bunTarget: "bun-windows-x64-baseline",
            key: "win32-x64",
            platform: "win32",
        });
        const names = new Set<string>();

        for (const path of resolverPaths) {
            const adapter = adapters.get(path);
            expect(adapter, `Missing standalone adapter for ${path}`).toBeDefined();
            expect(adapter!.required).toBe(true);
            const bundledSource = adapter!.adapt(readFileSync(path, "utf8"));
            expect(bundledSource).toContain('from "happy-agent:binary-assets"');
            expect(bundledSource).toContain("return getSupervisorBinary(key)");
            expect(bundledSource).not.toContain("require.resolve");
            names.add(adapter!.name);
        }

        // Each installed copy must independently satisfy the build's adapter gate.
        expect(names.size).toBe(resolverPaths.size);
    });
});
