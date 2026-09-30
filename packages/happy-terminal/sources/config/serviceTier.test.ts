import { describe, expect, it } from "vitest";
import { parseConfigToml } from "./parseConfigToml.js";
import { toTerminalServiceTier, toWireServiceTier } from "../client/serviceTierMapping.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRuntimeConfig } from "./writeRuntimeConfig.js";

describe("inference speed configuration", () => {
    it("round trips Ultrafast and an explicit Regular reset through runtime.toml", async () => {
        const directory = await mkdtemp(join(tmpdir(), "speed-config-"));
        const path = join(directory, "runtime.toml");
        try {
            await writeRuntimeConfig(path, { defaults: { serviceTier: "ultrafast" } });
            expect(parseConfigToml(await readFile(path, "utf8")).defaults?.serviceTier).toBe(
                "ultrafast",
            );
            await writeRuntimeConfig(path, { defaults: { serviceTier: null } });
            expect(parseConfigToml(await readFile(path, "utf8")).defaults?.serviceTier).toBeNull();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it.each(["fast", "ultrafast"] as const)("preserves %s in runtime TOML", (speed) => {
        expect(parseConfigToml(`[defaults]\nservice_tier = "${speed}"`).defaults?.serviceTier).toBe(
            speed,
        );
        expect(toTerminalServiceTier(toWireServiceTier(speed))).toBe(speed);
    });
    it("keeps Regular explicit and does not call an unknown provider tier Fast", () => {
        expect(
            parseConfigToml('[defaults]\nservice_tier = "default"').defaults?.serviceTier,
        ).toBeNull();
        expect(toTerminalServiceTier("unknown")).toBeUndefined();
        expect(toTerminalServiceTier(null)).toBeUndefined();
    });
});
