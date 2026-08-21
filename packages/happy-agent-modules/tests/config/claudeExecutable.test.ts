import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicProvider, resolveClaudeCodeExecutablePath } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("Claude executable configuration", () => {
    it("passes the platform executable to the Claude Agent SDK by default", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-claude-executable-"));
        temporaryDirectories.push(root);
        const configHome = join(root, "Happy", "Config");
        await mkdir(configHome, { recursive: true });
        await writeFile(
            join(configHome, "happy.toml"),
            [
                "[providers]",
                "default_enable = false",
                "",
                "[providers.claude]",
                "enabled = true",
                "credential_isolation = true",
                'api_key = "test-key"',
            ].join("\n"),
        );

        const config = await ConfigModule.load(join(root, ".happy"));
        const provider = await config.providers.resolve("claude", "anthropic/sonnet-5");

        expect(provider).toBeInstanceOf(AnthropicProvider);
        if (!(provider instanceof AnthropicProvider)) {
            throw new Error("Expected a Claude provider.");
        }
        const session = await provider.session("claude-executable", {
            instructions: "",
            tools: [],
        });
        try {
            expect(session).toHaveProperty(
                "pathToClaudeCodeExecutable",
                resolveClaudeCodeExecutablePath(),
            );
        } finally {
            await session.destroy();
        }
    });
});
