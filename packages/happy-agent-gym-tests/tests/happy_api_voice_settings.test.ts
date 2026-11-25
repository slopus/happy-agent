import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function updates(gym: AgentGym, after: string) {
    return (await gym.client.getEvents({ after, limit: 1000 })).events.filter(
        (event) => event.type === "config.updated",
    );
}

const runtimeToml = async (gym: AgentGym) =>
    await readFile(join(gym.happyHome, "agent", "runtime.toml"), "utf8");

describe("voice settings through the public API", () => {
    it("reports defaults, validates changes atomically, never stores the default prompt, and survives restart", async () => {
        const gym = await createAgentGym({ config: '[node]\nname = "Studio"\n' });
        running.push(gym);
        expect((await gym.client.getHealth()).capabilities).toMatchObject({
            desktopLiveControl: true,
            desktopLiveCapabilities: [
                "appState",
                "voiceFocus",
                "taskCreate",
                "sessionModelChange",
                "agentTargets",
                "failureReasons",
            ],
        });
        const initial = (await gym.client.getConfig()).config.voice!;
        expect(initial).toMatchObject({
            controller: {
                providerId: null,
                modelId: null,
                effort: null,
                fastMode: false,
                speed: null,
            },
            effectiveController: {
                providerId: "gym",
                modelId: "openai/gpt-6.2-sol",
                effort: "low",
                serviceTier: null,
                speed: "regular",
                speeds: ["regular"],
                notice: expect.stringContaining("voice cannot start"),
            },
            // The gym's scripted accounts are not OpenAI accounts, so none can carry a call.
            accounts: [],
            systemPromptOverride: null,
        });
        expect(initial.defaultSystemPrompt).toMatch(
            /^You are Happy, the voice side of the person.s coding agents/u,
        );
        expect(initial.effectiveSystemPrompt).toBe(initial.defaultSystemPrompt);

        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const changed = await gym.client.patchConfig({
            voice: { controller: { modelId: "gym/model-2", effort: "high", fastMode: true } },
        });
        expect(changed.config.voice).toMatchObject({
            controller: {
                providerId: null,
                modelId: "gym/model-2",
                effort: "high",
                fastMode: true,
            },
            effectiveController: {
                providerId: "gym",
                modelId: "gym/model-2",
                effort: "high",
                serviceTier: null,
                notice: "Fast is not available for Gym Model Two on this account, so voice uses Regular.",
            },
        });
        expect(await updates(gym, cursor)).toHaveLength(1);
        expect(await runtimeToml(gym)).toContain('controller_model = "gym/model-2"');

        for (const voice of [
            { controller: { effort: "xhigh" } },
            { controller: { providerId: "missing" } },
            { controller: { modelId: "gym/unknown" } },
            { systemPrompt: "   " },
            { controller: { speed: "warp" } },
        ]) {
            expect(
                await gym.raw.patch("/v0/config", { node: { name: "Renamed" }, voice }),
            ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
        }
        const unchanged = (await gym.client.getConfig()).config;
        expect(unchanged.node?.name).toBe("Studio");
        expect(unchanged.voice).toEqual(changed.config.voice);
        expect(await updates(gym, cursor)).toHaveLength(1);

        await gym.client.patchConfig({
            voice: { systemPrompt: "Speak like a lighthouse keeper." },
        });
        expect((await gym.client.getConfig()).config.voice).toMatchObject({
            systemPromptOverride: "Speak like a lighthouse keeper.",
            effectiveSystemPrompt: "Speak like a lighthouse keeper.",
        });
        await gym.client.patchConfig({ voice: { systemPrompt: initial.defaultSystemPrompt } });
        expect((await gym.client.getConfig()).config.voice?.systemPromptOverride).toBeNull();
        expect(await runtimeToml(gym)).not.toContain("system_prompt");
        expect(await updates(gym, cursor)).toHaveLength(3);
        await gym.client.patchConfig({ voice: {} });
        expect(await updates(gym, cursor)).toHaveLength(3);

        await gym.restart();
        expect((await gym.client.getConfig()).config.voice).toEqual(changed.config.voice);
        const beforeReset = await runtimeToml(gym);
        // This scripted catalog does not offer the built-in Sol model. A reset must validate
        // that resulting default instead of resurrecting the removed runtime model and effort.
        await expect(
            gym.client.patchConfig({ voice: { controller: { modelId: null, effort: null } } }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        expect((await gym.client.getConfig()).config.voice).toEqual(changed.config.voice);
        expect(await runtimeToml(gym)).toBe(beforeReset);
        await gym.client.patchConfig({ voice: { controller: { effort: null } } });
        expect((await gym.client.getConfig()).config.voice?.controller).toEqual({
            providerId: null,
            modelId: "gym/model-2",
            effort: null,
            fastMode: true,
            speed: null,
        });
        expect(gym.errors).toEqual([]);
    });

    it("lets only an active admin bot read and change voice settings through its tools", async () => {
        let adminId = "";
        let helperId = "";
        const calls = new Map<string, number>();
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Voice</title>" }] };
                const call = calls.get(request.sessionId) ?? 0;
                calls.set(request.sessionId, call + 1);
                if (request.sessionId !== adminId && request.sessionId !== helperId)
                    return { content: [{ type: "text", text: "Unexpected request." }] };
                if (call === 0)
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "set_voice_settings",
                                arguments: { systemPrompt: "Speak slowly." },
                            },
                        ],
                    };
                if (call === 1 && request.sessionId === adminId)
                    return {
                        content: [{ type: "tool_call", name: "get_voice_settings", arguments: {} }],
                    };
                return { content: [{ type: "text", text: "Finished." }] };
            },
        });
        running.push(gym);
        adminId = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!.agent.id;
        helperId = (await gym.client.createBot({ name: "Helper", isAdmin: false })).bot.agent.id;

        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await gym.send("Make voice speak slowly if you can.", {
            sessionId: helperId,
            permissionMode: "full_access",
        });
        const offered = (sessionId: string) =>
            gym.inference.requests
                .filter((request) => request.sessionId === sessionId)
                .flatMap((request) => request.tools.map((tool) => tool.name));
        expect(offered(helperId)).not.toContain("set_voice_settings");
        expect(offered(helperId)).not.toContain("get_voice_settings");
        expect((await gym.client.getConfig()).config.voice?.systemPromptOverride).toBeNull();
        expect(await updates(gym, cursor)).toEqual([]);

        await gym.send("Make voice speak slowly, then show me the voice settings.", {
            sessionId: adminId,
            permissionMode: "full_access",
        });
        expect((await gym.client.getConfig()).config.voice).toMatchObject({
            systemPromptOverride: "Speak slowly.",
            effectiveSystemPrompt: "Speak slowly.",
        });
        expect(await updates(gym, cursor)).toHaveLength(1);
        const adminRequests = gym.inference.requests.filter(
            (request) => request.sessionId === adminId,
        );
        expect(JSON.stringify(adminRequests.at(-1)?.messages)).toContain(
            "The voice model uses this prompt instead of its built-in one:\\nSpeak slowly.",
        );
        expect(gym.errors).toEqual([]);
    });
});
