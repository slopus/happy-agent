import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider types", () => {
    it("names each account by its provider type, never by its id", async () => {
        const root = await mkdtemp(join(tmpdir(), "provider-type-"));
        roots.push(root);
        const config = await testConfigRootedAt(
            root,
            [
                "[providers.claude_extra]",
                'type = "claude"',
                "enabled = true",
                "[providers.east]",
                'type = "bedrock"',
                'region = "us-east-1"',
                "enabled = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["codex"]',
                "enabled = true",
            ].join("\n"),
        );
        expect(config.providerType("claude_extra")).toBe("claude");
        expect(config.providerType("east")).toBe("bedrock");
        expect(config.providerType("codex")).toBe("codex");
        // A smart alias reports the type its routes are compatible with, as `/v0/config` does.
        expect(config.providerType("router")).toBe("codex");
        expect(config.providerType("nowhere")).toBeNull();
    });
});
