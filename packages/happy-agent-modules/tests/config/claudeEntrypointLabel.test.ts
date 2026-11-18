import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicProvider } from "@slopus/happy-providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadHappyAgentConfiguration, type ConfigModule } from "../../sources/config/index.js";
import {
    foreignAgentRoutes,
    foreignAgentStart,
} from "../../sources/config/impl/createForeignAgentProvider.js";
import { withClaudeEntrypointLabel } from "../../sources/config/impl/withClaudeEntrypointLabel.js";
import { testConfigRootedAt } from "../support/configModule.js";

// Anthropic meters `sdk-ts` and `sdk-cli` requests more heavily against a subscription's five-hour
// limit, so the experimental feature gives every Claude Code child Happy starts its own label.

const roots: string[] = [];
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-entrypoint-label-"));
    roots.push(root);
    const claudeHome = join(root, "claude");
    await mkdir(claudeHome, { recursive: true });
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"])
        vi.stubEnv(name, "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "token-for-test");
    // What a daemon started inside the Agent SDK, or inside another Claude session, inherits.
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "sdk-ts");
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("withClaudeEntrypointLabel", () => {
    it("leaves the environment unchanged when off", () => {
        const env = { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", HOME: "/home/alex" };
        expect(withClaudeEntrypointLabel(env, false)).toBe(env);
        expect(withClaudeEntrypointLabel({}, false)).toEqual({});
    });

    it("sets Happy's label when on", () => {
        expect(withClaudeEntrypointLabel({ HOME: "/home/alex" }, true)).toEqual({
            CLAUDE_CODE_ENTRYPOINT: "happy-agent",
            HOME: "/home/alex",
        });
    });

    it("overwrites an inherited entrypoint when on", () => {
        for (const inherited of ["sdk-ts", "sdk-cli", "claude-desktop", "cli"]) {
            const env = { CLAUDE_CODE_ENTRYPOINT: inherited };
            expect(withClaudeEntrypointLabel(env, true).CLAUDE_CODE_ENTRYPOINT).toBe("happy-agent");
            expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(inherited);
        }
    });
});

describe("[feature.claude_entrypoint_label]", () => {
    it("is off by default and keeps Happy's Claude loop on the inherited environment", async () => {
        const config = await claudeConfig();
        expect(config.configuration.values.feature.claudeEntrypointLabel).toEqual({
            enabled: false,
        });
        const env = await claudeSessionEnvironment(config);
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    });

    it("labels Happy's own Claude loop over an inherited sdk-ts", async () => {
        const config = await claudeConfig("[feature.claude_entrypoint_label]\nenabled = true\n");
        expect(config.configuration.provenance["feature.claudeEntrypointLabel.enabled"]).toBe(
            "global",
        );
        const env = await claudeSessionEnvironment(config);
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("happy-agent");
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-for-test");
    });

    it("labels the Claude Code harness only, and only when on", async () => {
        const harnesses = "[harnesses.claude_code]\n[harnesses.codex_cli]\n[providers.codex]\n";
        const start = async (toml: string, harness: string) => {
            const config = await claudeConfig(toml);
            const route = foreignAgentRoutes(config.configuration).find(
                (candidate) => candidate.harnessId === harness,
            );
            if (route === undefined) throw new Error(`Expected a ${harness} route.`);
            return foreignAgentStart(route).env;
        };
        const on = `${harnesses}[feature.claude_entrypoint_label]\nenabled = true\n`;

        expect(await start(harnesses, "claude_code")).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
        expect(await start(on, "claude_code")).toMatchObject({
            CLAUDE_CODE_ENTRYPOINT: "happy-agent",
        });
        expect(await start(on, "codex_cli")).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    });

    it("cannot be turned on by a project configuration", async () => {
        const previous = process.cwd();
        await writeFile(
            join(root, "happy.toml"),
            "[feature.claude_entrypoint_label]\nenabled = true\n",
        );
        process.chdir(root);
        try {
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));
            expect(configuration.values.feature.claudeEntrypointLabel.enabled).toBe(false);
            expect(
                configuration.provenance["feature.claudeEntrypointLabel.enabled"],
            ).toBeUndefined();
        } finally {
            process.chdir(previous);
        }
    });
});

async function claudeConfig(extra = ""): Promise<ConfigModule> {
    return await testConfigRootedAt(
        root,
        `[providers]\ndefault_enable = false\n[providers.claude]\nenabled = true\n${extra}`,
    );
}

async function claudeSessionEnvironment(config: ConfigModule): Promise<NodeJS.ProcessEnv> {
    const provider = await config.providers.resolve("claude", "anthropic/sonnet-5");
    if (!(provider instanceof AnthropicProvider)) throw new Error("Expected a Claude provider.");
    const session = await provider.session("claude-entrypoint-label", {
        instructions: "",
        tools: [],
    });
    try {
        if (!("env" in session)) throw new Error("Expected a Claude Code session.");
        return session.env as NodeJS.ProcessEnv;
    } finally {
        await session.destroy();
    }
}
