import type { MessageMode } from "@slopus/happy-agent-client";
import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it, vi } from "vitest";

it("announces a mid-run fallback configuration before its first streamed output and persists the same order", async () => {
    const modelId = "openai/gpt-5.6-sol";
    const mode: MessageMode = {
        providerId: "router",
        modelId,
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    };
    // Smart routes choose their initial account randomly, then remain sticky per agent.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        providerIds: ["gym", "other"],
        models: ["gym", "other", "router"].map((providerId) => ({
            id: modelId,
            providerId,
            name: "Fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        // The scripted model calls list_skills directly, which a code-mode model reaches only
        // through exec; the fallback, not that tool surface, is under test.
        config: `[feature.codex_exec]
enabled = false
[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
[providers.other]
type = "codex"
enabled = true
[providers.router]
type = "smart"
enabled = true
providers = ["gym", "other"]
`,
        inference: [
            {
                providerId: "gym",
                content: [
                    { type: "text", text: "First account output." },
                    {
                        type: "tool_call",
                        name: "list_skills",
                        arguments: {},
                        callId: "route-probe",
                    },
                ],
            },
            {
                providerId: "gym",
                error: {
                    message: "First account rejected the next inference.",
                    providerError: { type: "authentication" },
                },
            },
            {
                providerId: "other",
                content: [{ type: "text", text: "Fallback account output." }],
            },
        ],
    });
    try {
        const submitted = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Inspect skills, then finish through the available account.",
            mode,
        });
        await gym.waitForEvent(
            (event) => event.type === "run.finished",
            "the routed execution to finish",
        );
        const page = await gym.client.getMessages(gym.defaultSessionId);
        const messages = page.runs.flatMap((run) => run.messages);
        const configurations = messages.filter((message) =>
            message.content.some((block) => block.type === "configuration"),
        );
        const blocks = configurations.flatMap((message) =>
            message.content.filter((block) => block.type === "configuration"),
        );
        expect(gym.inference.requests.map((request) => request.providerId)).toEqual([
            "gym",
            "gym",
            "other",
        ]);
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]?.status).toBe("completed");
        expect.soft(blocks).toHaveLength(2);
        expect.soft(blocks.filter((block) => block.before === null)).toHaveLength(1);
        expect.soft(blocks[0]).toEqual({
            type: "configuration",
            before: null,
            after: { ...mode, providerId: "gym" },
            beforeMessageId: submitted.message.id,
        });
        expect.soft(blocks[1]).toEqual({
            type: "configuration",
            before: { ...mode, providerId: "gym" },
            after: { ...mode, providerId: "other" },
            beforeMessageId: null,
        });
        const firstOutput = messages.findIndex((message) =>
            message.content.some(
                (block) => block.type === "text" && block.text === "First account output.",
            ),
        );
        const tool = messages.findIndex((message) =>
            message.content.some(
                (block) =>
                    block.type === "tool_call" &&
                    block.name === "list_skills" &&
                    block.status === "completed",
            ),
        );
        const fallbackOutput = messages.findIndex((message) =>
            message.content.some(
                (block) => block.type === "text" && block.text === "Fallback account output.",
            ),
        );
        const fallbackConfiguration = messages.findIndex(
            (message) => message.id === configurations[1]?.id,
        );
        expect(firstOutput).toBeGreaterThanOrEqual(0);
        expect(tool).toBeGreaterThanOrEqual(firstOutput);
        expect.soft(fallbackConfiguration).toBeGreaterThan(tool);
        expect.soft(fallbackOutput).toBe(fallbackConfiguration + 1);
        const created = (await gym.events()).flatMap((event) =>
            event.type === "message.created" ? [event.payload.message] : [],
        );
        // API.md:4614-4628: null-anchored rows keep their chronological position live and durably.
        expect
            .soft(created.map((message) => message.id))
            .toEqual(messages.map((message) => message.id));
        expect
            .soft(created.filter((message) => configurations.some((row) => row.id === message.id)))
            .toEqual(configurations);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
        random.mockRestore();
    }
}, 30_000);

it("announces the earlier no-output failed account and the successful fallback before the first output", async () => {
    const modelId = "openai/gpt-5.6-sol";
    const mode: MessageMode = {
        providerId: "router",
        modelId,
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    };
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        providerIds: ["gym", "other"],
        models: ["gym", "other", "router"].map((providerId) => ({
            id: modelId,
            providerId,
            name: "Fixture model",
            defaultEffort: "medium",
            effortLevels: ["medium"],
        })),
        config: `[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
[providers.other]
type = "codex"
enabled = true
[providers.router]
type = "smart"
enabled = true
providers = ["gym", "other"]
`,
        inference: [
            {
                providerId: "gym",
                error: {
                    message: "First account rejected without output.",
                    providerError: { type: "authentication" },
                },
            },
            {
                providerId: "other",
                content: [{ type: "text", text: "First visible output from fallback." }],
            },
        ],
    });
    try {
        const sent = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Use the available account.",
            mode,
        });
        await gym.waitForEvent(
            (event) => event.type === "run.finished",
            "the fallback execution to finish",
        );
        expect(gym.inference.requests.map((request) => request.providerId)).toEqual([
            "gym",
            "other",
        ]);
        const page = await gym.client.getMessages(gym.defaultSessionId);
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]?.status).toBe("completed");
        const messages = page.runs.flatMap((run) => run.messages);
        const configurations = messages.filter((message) =>
            message.content.some((block) => block.type === "configuration"),
        );
        expect.soft(configurations.map((message) => message.content)).toEqual([
            [
                {
                    type: "configuration",
                    before: null,
                    after: { ...mode, providerId: "gym" },
                    beforeMessageId: sent.message.id,
                },
            ],
            [
                {
                    type: "configuration",
                    before: { ...mode, providerId: "gym" },
                    after: { ...mode, providerId: "other" },
                    beforeMessageId: null,
                },
            ],
        ]);
        expect
            .soft(messages.map((message) => message.role))
            .toEqual(["user", "service", "service", "agent"]);
        const created = (await gym.events()).flatMap((event) =>
            event.type === "message.created" ? [event.payload.message] : [],
        );
        expect
            .soft(created.map((message) => message.id))
            .toEqual(messages.map((message) => message.id));
        expect
            .soft(created.filter((message) => configurations.some((row) => row.id === message.id)))
            .toEqual(configurations);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
        random.mockRestore();
    }
}, 30_000);
