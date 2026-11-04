import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpProvider } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import {
    foreignAgentRoutes,
    foreignAgentStart,
} from "../../sources/config/impl/createForeignAgentProvider.js";
import { parseAntigravityUsage } from "../../sources/config/impl/harnessUsage.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "harnesses-"));
    roots.push(directory);
    return directory;
}

async function report(directory: string, models: readonly object[]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "models.json"), JSON.stringify(models));
}

function reported(id: string, name: string) {
    return {
        id,
        name,
        effortLevels: ["low", "high"],
        defaultEffort: "high",
        contextWindow: 400_000,
    };
}

const ACCOUNTS = [
    "[providers.claude]",
    "enabled = true",
    "[providers.claude_alex_acme]",
    'type = "claude"',
    'name = "alex acme"',
    'oauth_token = "token-for-test"',
    "enabled = true",
    "[providers.codex]",
    "enabled = true",
    "[providers.codex_alex_personal]",
    'type = "codex"',
    'auth_file = "/Users/alex/.codex-personal/auth.json"',
    "enabled = true",
];

describe("harnesses", () => {
    it("offers current Codex CLI generations first while honoring an explicit include order", async () => {
        for (const include of [undefined, ["codex-cli/gpt-6-sol", "codex-cli/gpt-6.1-terra"]]) {
            const config = await testConfigRootedAt(
                await root(),
                [
                    ...ACCOUNTS,
                    "[harnesses.codex_cli]",
                    ...(include === undefined
                        ? []
                        : [`include_models = ${JSON.stringify(include)}`]),
                ].join("\n"),
            );
            await report(
                join(config.configuration.paths.agentHome, "foreign-agents", "codex_cli", "codex"),
                [
                    reported("codex-cli/gpt-6-sol", "GPT-6 Sol"),
                    reported("codex-cli/future-model", "Future model"),
                    reported("codex-cli/gpt-5.6-sol", "GPT-5.6 Sol"),
                    reported("codex-cli/gpt-6.1-terra", "GPT-6.1 Terra"),
                    reported("codex-cli/gpt-5.6-terra", "GPT-5.6 Terra"),
                    reported("codex-cli/gpt-6.1-sol", "GPT-6.1 Sol"),
                    reported("codex-cli/gpt-7-luna", "GPT-7 Luna"),
                ],
            );
            expect(
                config.offeredModels
                    .filter(
                        (model) =>
                            model.providerId === "codex" && model.id.startsWith("codex-cli/"),
                    )
                    .map((model) => model.id),
            ).toEqual(
                include ?? [
                    "codex-cli/gpt-7-luna",
                    "codex-cli/gpt-6.1-terra",
                    "codex-cli/gpt-6.1-sol",
                    "codex-cli/gpt-6-sol",
                    "codex-cli/future-model",
                ],
            );
        }
    });

    it("runs Claude Code and Codex CLI on the accounts they accept, beside Happy's own models", async () => {
        const config = await testConfigRootedAt(
            await root(),
            [
                ...ACCOUNTS,
                "[harnesses.claude_code]",
                'providers = ["claude_alex_acme"]',
                "[harnesses.codex_cli]",
            ].join("\n"),
        );
        const routes = config.offeredModels.map((model) => `${model.providerId}:${model.id}`);
        // Happy's loop still runs on every provider.
        expect(routes).toContain("claude:anthropic/opus-5-5");
        expect(routes).toContain("claude_alex_acme:anthropic/opus-5-5");
        // Claude Code runs only on the account it lists; Codex CLI on every codex account.
        expect(routes).toContain("claude_alex_acme:claude-code/opus");
        expect(routes).not.toContain("claude:claude-code/opus");
        expect(routes).toContain("codex:codex-cli/gpt-6.1-sol");
        expect(routes).toContain("codex_alex_personal:codex-cli/gpt-6.1-sol");

        const claude = await config.resolveProviderUnchecked(
            "claude_alex_acme",
            "claude-code/opus",
        );
        expect(claude).toBeInstanceOf(AcpProvider);
        expect((claude as AcpProvider).options.stateDirectory).toContain(
            join("foreign-agents", "claude_code", "claude_alex_acme"),
        );
        const native = await config.resolveProviderUnchecked(
            "claude_alex_acme",
            "anthropic/opus-5-5",
        );
        expect(native).not.toBeInstanceOf(AcpProvider);

        const all = foreignAgentRoutes(config.configuration);
        const route = (harness: string, provider: string) =>
            all.find((r) => r.harnessId === harness && r.providerId === provider)!;
        expect(foreignAgentStart(route("claude_code", "claude_alex_acme")).env).toMatchObject({
            CLAUDE_CODE_OAUTH_TOKEN: "token-for-test",
        });
        expect(foreignAgentStart(route("codex_cli", "codex_alex_personal")).env).toMatchObject({
            CODEX_HOME: "/Users/alex/.codex-personal",
        });
        expect(foreignAgentStart(route("codex_cli", "codex")).env).toEqual({});
    });

    it("runs Claude Code from a Claude account's executable unless the harness names one", async () => {
        const accounts = [
            "[providers.claude]",
            "enabled = true",
            'executable = "/opt/claude/bin/claude"',
            "[providers.claude_alex_acme]",
            'type = "claude"',
            'oauth_token = "token-for-test"',
            "enabled = true",
            "[harnesses.claude_code]",
        ];
        const start = async (lines: readonly string[], provider: string) => {
            const config = await testConfigRootedAt(await root(), lines.join("\n"));
            const route = foreignAgentRoutes(config.configuration).find(
                (r) => r.harnessId === "claude_code" && r.providerId === provider,
            )!;
            return foreignAgentStart(route);
        };
        expect((await start(accounts, "claude")).command).toBe("/opt/claude/bin/claude");
        expect((await start(accounts, "claude_alex_acme")).command).toBeUndefined();
        expect(
            (await start([...accounts, 'command = "/opt/pinned/claude"'], "claude")).command,
        ).toBe("/opt/pinned/claude");
    });

    it("offers agents with their own login as accounts named after their harness", async () => {
        const config = await testConfigRootedAt(
            await root(),
            [
                "[harnesses.antigravity]",
                "[harnesses.opencode]",
                "[harnesses.goose]",
                'type = "acp"',
                'name = "Goose"',
                'command = "goose"',
                'args = ["acp"]',
                'env = { GOOSE_PROVIDER = "openai" }',
            ].join("\n"),
        );
        expect(config.providerType("antigravity")).toBe("antigravity");
        expect(config.providerName("antigravity")).toBe("Antigravity");
        expect(config.providerName("opencode")).toBe("OpenCode");
        expect(config.providerName("goose")).toBe("Goose");
        const routes = config.offeredModels.map((model) => `${model.providerId}:${model.id}`);
        expect(routes).toContain("antigravity:antigravity/gemini-3.8-flash");
        // Agents without a built-in list offer nothing until they have reported their models.
        expect(routes.some((route) => route.startsWith("opencode:"))).toBe(false);
        expect(routes.some((route) => route.startsWith("goose:"))).toBe(false);
        const goose = foreignAgentRoutes(config.configuration).find(
            (r) => r.harnessId === "goose",
        )!;
        expect(foreignAgentStart(goose)).toEqual({
            command: "goose",
            args: ["acp"],
            env: { GOOSE_PROVIDER: "openai" },
        });
    });

    it("offers the models an agent reports, picked and ordered by its harness", async () => {
        const config = await testConfigRootedAt(
            await root(),
            [
                "[harnesses.goose]",
                'type = "acp"',
                'command = "goose"',
                'include_models = ["acp/goose/c", "acp/goose/a", "acp/goose/not-served"]',
                'exclude_models = ["acp/goose/a"]',
                ...ACCOUNTS,
                "[harnesses.claude_code]",
                'include_models = ["claude-code/sonnet"]',
            ].join("\n"),
        );
        const home = config.configuration.paths.agentHome;
        await report(join(home, "foreign-agents", "goose"), [
            reported("acp/goose/a", "A"),
            reported("acp/goose/b", "B"),
            reported("acp/goose/c", "C"),
        ]);
        await report(join(home, "foreign-agents", "claude_code", "claude"), [
            reported("claude-code/opus", "Opus"),
            reported("claude-code/sonnet", "Sonnet"),
        ]);
        const offered = (provider: string) =>
            config.offeredModels
                .filter((model) => model.providerId === provider)
                .map((model) => model.id);
        expect(offered("goose")).toEqual(["acp/goose/c"]);
        expect(offered("claude").filter((id) => id.startsWith("claude-code/"))).toEqual([
            "claude-code/sonnet",
        ]);
        expect(config.isProviderEnabled("goose")).toBe(true);
        expect(config.modelContext("goose", "acp/goose/c")).toEqual({
            contextWindow: 400_000,
            autoCompactWindow: 400_000,
        });
    });

    it("lets Happy's own loop run only on the providers it lists", async () => {
        const config = await testConfigRootedAt(
            await root(),
            [
                ...ACCOUNTS,
                "[harnesses.happy]",
                'providers = ["claude"]',
                "[harnesses.claude_code]",
            ].join("\n"),
        );
        const routes = config.offeredModels.map((model) => `${model.providerId}:${model.id}`);
        expect(routes).toContain("claude:anthropic/opus-5-5");
        expect(routes).not.toContain("claude_alex_acme:anthropic/opus-5-5");
        expect(routes).toContain("claude_alex_acme:claude-code/opus");
    });

    it.each([
        [["[harnesses.goose]", 'type = "acp"'], "must set command"],
        [["[harnesses.mystery]"], "must set type"],
        [["[harnesses.cc]", 'type = "claude-code"'], "[harnesses.claude_code]"],
        [["[harnesses.claude_code]", 'providers = ["codex"]', "[providers.codex]"], "runs on"],
        [["[harnesses.claude_code]", 'providers = ["nobody"]'], "unknown provider"],
        [["[harnesses.happy]", 'subagent_harnesses = ["goose"]'], "unknown sub-agent harness"],
        [["[providers.goose]", 'type = "acp"', 'command = "goose"'], "[harnesses.goose]"],
        [
            [
                "[providers.antigravity]",
                'type = "smart"',
                'providers = ["claude"]',
                "[harnesses.antigravity]",
            ],
            "same ID",
        ],
    ])("refuses %j", async (lines, message) => {
        await expect(testConfigRootedAt(await root(), lines.join("\n"))).rejects.toThrow(message);
    });

    it("lets Happy reach foreign harnesses it has no counterpart for, and foreign ones all but Happy", async () => {
        const config = await testConfigRootedAt(
            await root(),
            [
                ...ACCOUNTS,
                "[harnesses.claude_code]",
                "[harnesses.codex_cli]",
                "[harnesses.antigravity]",
                "[harnesses.opencode]",
                "[harnesses.goose]",
                'type = "acp"',
                'command = "goose"',
                "subagent_harnesses = []",
            ].join("\n"),
        );
        const reach = (creator: string) =>
            ["happy", "claude_code", "codex_cli", "antigravity", "opencode", "goose"].filter(
                (target) => config.harnessAllowsSubagents(creator, target),
            );
        expect(reach("happy")).toEqual(["happy", "antigravity"]);
        expect(reach("antigravity")).toEqual([
            "claude_code",
            "codex_cli",
            "antigravity",
            "opencode",
            "goose",
        ]);
        // An explicit list replaces the default; its own harness stays reachable.
        expect(reach("goose")).toEqual(["goose"]);
        expect(config.harnessOf("claude", "claude-code/opus")).toBe("claude_code");
        expect(config.harnessOf("claude", "anthropic/opus-5-5")).toBe("happy");
        expect(config.harnessName("codex_cli")).toBe("Codex CLI");
    });

    it("reads Antigravity's quota windows from its usage report", () => {
        expect(
            parseAntigravityUsage(
                [
                    "Model Family\tWindow\tRemaining\tResets",
                    "Gemini Models\tWeekly Limit Remaining\t95%\t2026-10-27T00:00:00Z",
                    "Argon\tWeekly Limit Remaining\t0\tsoon",
                    "noise without tabs",
                ].join("\n"),
            ),
        ).toEqual([
            {
                scope: "Gemini Models",
                window: "Weekly Limit Remaining",
                remainingPercent: 95,
                resetsAt: "2026-10-27T00:00:00Z",
            },
            {
                scope: "Argon",
                window: "Weekly Limit Remaining",
                remainingPercent: 0,
                resetsAt: null,
            },
        ]);
    });
});
