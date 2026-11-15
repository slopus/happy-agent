import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAgentContext, type AgentSystemRef } from "@slopus/happy-agent-base";
import type { AcpProvider, AcpTurnEnvironment } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type BackgroundWorkEnvironment = AcpTurnEnvironment & {
    readonly backgroundWork?: (running: number) => void;
};

it("tells its listeners how much background work the foreign agent behind each agent runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "foreign-agent-background-work-"));
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
    config.beforeStart(createRootContext().named("test"), {} as AgentSystemRef);
    const reports: (readonly [string, number])[] = [];
    const stop = config.onForeignAgentBackgroundWork((agentId, running) => {
        reports.push([agentId, running]);
    });
    const throwing = config.onForeignAgentBackgroundWork(() => {
        throw new Error("A listener that fails never breaks the report.");
    });

    const provider = (await config.resolveProviderUnchecked(
        "claude_alex_acme",
        "claude-code/opus",
    )) as AcpProvider;
    // Counts arrive long after the turn that ran the agent, so they name the agent from its context.
    const turn = withAgentContext(createRootContext().named("turn"), {
        id: "agent-7",
        provider: "claude_alex_acme",
        permissionMode: "workspace_write",
    });
    const environment: BackgroundWorkEnvironment = provider.options.environment(turn);
    environment.backgroundWork?.(2);
    environment.backgroundWork?.(0);
    // A context that names no agent has nobody to count the work for.
    const unnamed: BackgroundWorkEnvironment = provider.options.environment(
        createRootContext().named("no-agent"),
    );
    unnamed.backgroundWork?.(5);
    stop();
    throwing();
    environment.backgroundWork?.(3);

    expect(reports).toEqual([
        ["agent-7", 2],
        ["agent-7", 0],
    ]);
});
