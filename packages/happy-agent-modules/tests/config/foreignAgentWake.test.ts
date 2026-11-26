import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAgentContext, type AgentSystemRef } from "@slopus/happy-agent-base";
import type { AcpProvider, SessionSystemMessage } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("wakes the agent a foreign agent runs as with a hidden notice when it starts a turn on its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "foreign-agent-wake-"));
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
    const sent: unknown[][] = [];
    const agents = {
        send: async (...args: unknown[]) => {
            sent.push(args);
            return { id: "accepted", status: "created" };
        },
    } as unknown as AgentSystemRef;
    config.beforeStart(createRootContext().named("test"), agents);

    const provider = (await config.resolveProviderUnchecked(
        "claude_alex_acme",
        "claude-code/opus",
    )) as AcpProvider;
    // The turn that ran the agent is long over by the time its foreign agent starts one itself.
    const turn = withAgentContext(createRootContext().named("turn"), {
        id: "agent-7",
        provider: "claude_alex_acme",
        permissionMode: "workspace_write",
    });
    const notice: SessionSystemMessage = {
        role: "system",
        content: [{ type: "text", text: "A turn started on its own." }],
    };
    const environment: {
        readonly cwd: string;
        readonly wake?: (notice: SessionSystemMessage) => void;
    } = provider.options.environment(turn);
    environment.wake?.(notice);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.slice(1)).toEqual(["agent-7", notice, { metadata: { hideFromUser: true } }]);
});
