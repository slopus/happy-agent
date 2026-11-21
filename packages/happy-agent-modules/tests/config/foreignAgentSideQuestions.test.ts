import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpProvider } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ctx = createRootContext().named("test");
const mode = { providerId: "claude_alex_acme", modelId: "claude-code/opus", effort: "high" };
const sideQuestion = () => ({
    question: "What are you changing?",
    history: [],
    signal: new AbortController().signal,
});

async function claudeCodeConfig() {
    const root = await mkdtemp(join(tmpdir(), "foreign-agent-side-questions-"));
    roots.push(root);
    const config = await testConfigRootedAt(
        root,
        [
            "[providers.claude_alex_acme]",
            'type = "claude"',
            'oauth_token = "token-for-test"',
            "enabled = true",
            "[harnesses.claude_code]",
            'providers = ["claude_alex_acme"]',
        ].join("\n"),
    );
    config.beforeStart();
    return config;
}

it("knows which models a harness that answers side questions runs", async () => {
    const config = await claudeCodeConfig();

    expect(config.answersSideQuestions("claude_alex_acme", "claude-code/opus")).toBe(true);
    expect(config.answersSideQuestions("claude_alex_acme", "anthropic/opus-5")).toBe(false);
    expect(
        await config.askSideQuestion(
            ctx,
            "agent-7",
            { ...mode, modelId: "anthropic/opus-5" },
            sideQuestion(),
        ),
    ).toEqual({ status: "unsupported" });
});

it("asks the agent's open foreign session, and nothing once that session is destroyed", async () => {
    const config = await claudeCodeConfig();
    const provider = (await config.resolveProviderUnchecked(
        "claude_alex_acme",
        "claude-code/opus",
    )) as AcpProvider;
    const session = await provider.session("agent-7", { instructions: "Be Happy.", tools: [] });
    const asked: string[] = [];
    // Stands in for the Claude Code process the agent's turns keep open.
    session.askSideQuestion = async (question) => {
        asked.push(question.question);
        return { response: "The parser.", synthetic: false };
    };

    expect(await config.askSideQuestion(ctx, "agent-7", mode, sideQuestion())).toEqual({
        status: "answered",
        answer: { response: "The parser.", synthetic: false },
    });
    expect(asked).toEqual(["What are you changing?"]);
    // Another agent's question never reaches this agent's session.
    expect(await config.askSideQuestion(ctx, "agent-8", mode, sideQuestion())).toEqual({
        status: "harness_not_running",
    });

    session.destroy();
    // Nothing is stored for the agent either, so there is no conversation to answer from.
    expect(await config.askSideQuestion(ctx, "agent-7", mode, sideQuestion())).toEqual({
        status: "harness_not_running",
    });
    expect(asked).toEqual(["What are you changing?"]);
});
