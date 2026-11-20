import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentModel } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";

import {
    verificationCandidates,
    verificationEffort,
} from "../../sources/providerScan/verificationCandidates.js";
import { testConfigRootedAt } from "../support/configModule.js";

describe("verificationCandidates", () => {
    it("orders a provider's models cheapest first and never offers Fable", () => {
        const models = [
            "anthropic/fable-5-2",
            "anthropic/opus-5-5",
            "anthropic/sonnet-5-5",
            "anthropic/haiku-5-5",
            "anthropic/fable-5-1",
            "anthropic/opus-5",
            "anthropic/sonnet-5",
            "anthropic/fable-5",
            "anthropic/fable-6",
        ].map((id) => model("claude", id));

        const { candidates, onlyFable } = verificationCandidates(models, "claude");

        expect(candidates.map(({ id }) => id)).toEqual([
            "anthropic/haiku-5-5",
            "anthropic/sonnet-5-5",
            "anthropic/sonnet-5",
            "anthropic/opus-5-5",
            "anthropic/opus-5",
        ]);
        expect(onlyFable).toBe(false);
    });

    it("ranks across vendors and leaves unranked models last in configuration order", () => {
        const models = [
            model("bedrock", "openai/gpt-6.2-astra"),
            model("bedrock", "zai/glm-5.3"),
            model("bedrock", "openai/gpt-6.2-sol"),
            model("bedrock", "anthropic/opus-5"),
            model("bedrock", "moonshotai/kimi-k3"),
            model("bedrock", "anthropic/sonnet-5"),
            model("bedrock", "openai/gpt-6.1-terra"),
            model("bedrock", "openai/gpt-6-luna"),
            model("other", "anthropic/haiku-5-5"),
        ];

        expect(verificationCandidates(models, "bedrock").candidates.map(({ id }) => id)).toEqual([
            "openai/gpt-6-luna",
            "anthropic/sonnet-5",
            "openai/gpt-6.1-terra",
            "openai/gpt-6.2-sol",
            "anthropic/opus-5",
            "openai/gpt-6.2-astra",
            "zai/glm-5.3",
            "moonshotai/kimi-k3",
        ]);
    });

    it("puts Composer before the full Grok models", () => {
        const models = ["xai/grok-4.7", "xai/grok-build", "xai/grok-composer-2.5-fast"].map((id) =>
            model("grok", id),
        );
        expect(verificationCandidates(models, "grok").candidates.map(({ id }) => id)).toEqual([
            "xai/grok-composer-2.5-fast",
            "xai/grok-4.7",
            "xai/grok-build",
        ]);
    });

    it("ranks a family the same through a harness and never offers Fable there", () => {
        const claudeCode = ["claude-code/fable", "claude-code/opus", "claude-code/sonnet[1m]"]
            .concat("claude-code/haiku")
            .map((id) => model("claude", id));
        expect(verificationCandidates(claudeCode, "claude").candidates.map(({ id }) => id)).toEqual(
            ["claude-code/haiku", "claude-code/sonnet[1m]", "claude-code/opus"],
        );

        const codexCli = [
            "codex-cli/gpt-6.2-sol",
            "codex-cli/gpt-6.2-astra",
            "codex-cli/gpt-6.1-terra",
            "codex-cli/gpt-6-luna",
        ].map((id) => model("codex", id));
        expect(verificationCandidates(codexCli, "codex").candidates.map(({ id }) => id)).toEqual([
            "codex-cli/gpt-6-luna",
            "codex-cli/gpt-6.1-terra",
            "codex-cli/gpt-6.2-sol",
            "codex-cli/gpt-6.2-astra",
        ]);

        const antigravity = [
            "antigravity/gemini-4-carbon",
            "antigravity/claude-opus-5-5",
            "antigravity/gpt-oss-120b",
            "antigravity/gemini-3.8-flash",
            "antigravity/claude-fable-5-2",
            "antigravity/claude-sonnet-5-5",
        ].map((id) => model("antigravity", id));
        expect(
            verificationCandidates(antigravity, "antigravity").candidates.map(({ id }) => id),
        ).toEqual([
            "antigravity/gemini-3.8-flash",
            "antigravity/gemini-4-carbon",
            "antigravity/claude-sonnet-5-5",
            "antigravity/claude-opus-5-5",
            "antigravity/gpt-oss-120b",
        ]);

        const opencode = ["opencode/anthropic/fable-5", "opencode/openai/gpt-6-luna"].map((id) =>
            model("opencode", id),
        );
        expect(verificationCandidates(opencode, "opencode").candidates.map(({ id }) => id)).toEqual(
            ["opencode/openai/gpt-6-luna"],
        );
        expect(verificationCandidates([model("claude", "claude-code/fable")], "claude")).toEqual({
            candidates: [],
            onlyFable: true,
        });
    });

    it("reports a provider that offers only Fable models", () => {
        const models = [
            model("bedrock", "anthropic/fable-5"),
            model("bedrock", "anthropic/fable-5-2"),
        ];
        expect(verificationCandidates(models, "bedrock")).toEqual({
            candidates: [],
            onlyFable: true,
        });
        expect(verificationCandidates([], "bedrock")).toEqual({ candidates: [], onlyFable: false });
    });
});

describe("verificationCandidates over configured harnesses", () => {
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true })));
    });

    async function offeredModels(toml: string): Promise<readonly AgentModel[]> {
        const root = await mkdtemp(join(tmpdir(), "verification-candidates-"));
        roots.push(root);
        return (await testConfigRootedAt(root, toml)).offeredModels;
    }

    it.each([
        [
            "Claude Code",
            "claude",
            '[providers.claude]\nenabled = true\noauth_token = "sk-ant-oat01-test"\n[harnesses.happy]\nproviders = []\n[harnesses.claude_code]\n',
            "claude-code/haiku",
        ],
        [
            "Codex CLI",
            "codex",
            '[providers.codex]\nenabled = true\napi_key = "sk-test"\n[harnesses.happy]\nproviders = []\n[harnesses.codex_cli]\n',
            "codex-cli/gpt-6-luna",
        ],
        ["Antigravity", "antigravity", "[harnesses.antigravity]\n", "antigravity/gemini-3.8-flash"],
    ])("verifies %s with its cheapest model first", async (_name, providerId, toml, cheapest) => {
        const models = await offeredModels(toml);
        expect(models.find(({ id }) => id === cheapest)?.providerId).toBe(providerId);
        expect(verificationCandidates(models, providerId).candidates[0]?.id).toBe(cheapest);
    });
});

describe("verificationEffort", () => {
    it.each<[AgentModel["effortLevels"], AgentModel["defaultEffort"], string]>([
        [["off", "low", "medium", "high", "xhigh", "max"], "medium", "low"],
        [["low", "medium", "high", "xhigh", "max"], "medium", "low"],
        [["off", "minimal", "medium", "high"], "medium", "minimal"],
        [["off", "medium"], "off", "medium"],
        [["high", "xhigh"], "high", "high"],
        [["off", "high"], "off", "high"],
        [["off"], "off", "off"],
    ])("picks the cheapest effort of %j other than off", (effortLevels, defaultEffort, chosen) => {
        expect(
            verificationEffort({
                ...model("claude", "anthropic/sonnet-5"),
                defaultEffort,
                effortLevels,
            }),
        ).toBe(chosen);
    });
});

function model(providerId: string, id: string): AgentModel {
    return {
        defaultEffort: "medium",
        effortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        id,
        name: id,
        providerId,
    };
}
