import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Live API stays separate from ordinary coding sessions", () => {
    it("advertises the window contract but refuses unavailable voice credentials without breaking coding", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ type: "text", text: "Coding remains available." }] }],
        });
        running.add(gym);
        expect(await gym.client.getHealth()).toMatchObject({
            ready: true,
            capabilities: { desktopLiveControl: true },
        });
        await expect(
            gym.client.createLiveSession({
                id: "livefixture",
                windowId: "window-fixture",
                credential: { type: "openai_api_key", providerId: "gym" },
                sdp: "v=fixture",
                contextRevision: 1,
                context: {
                    windowId: "window-fixture",
                    connections: [],
                    activeConnectionId: null,
                    activeTarget: null,
                    projects: [],
                    workspaces: [],
                    sessions: [],
                    bots: [],
                    activeSession: null,
                    truncated: false,
                },
            }),
        ).rejects.toMatchObject({ status: 503, code: "live_unavailable" });
        await expect(gym.client.getLiveSession("livefixture")).rejects.toMatchObject({
            status: 404,
        });
        await gym.send("Continue ordinary coding.");
        expect(JSON.stringify(await gym.history())).toContain("Coding remains available.");
    }, 30000);

    it("rejects unknown Live fields and a mismatched context window before reserving", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const body = {
            id: "livefixture",
            windowId: "window-fixture",
            credential: { type: "openai_api_key", providerId: "gym" },
            sdp: "v=fixture",
            contextRevision: 1,
            context: {
                windowId: "other-window",
                connections: [],
                activeConnectionId: null,
                activeTarget: null,
                projects: [],
                workspaces: [],
                sessions: [],
                bots: [],
                activeSession: null,
                truncated: false,
            },
        };
        expect(await gym.raw.post("/v0/live/sessions", body)).toMatchObject({
            status: 400,
            body: { code: "invalid_request" },
        });
        expect(
            await gym.raw.post("/v0/live/sessions", { ...body, permissionMode: "full_access" }),
        ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
        expect(await gym.raw.get("/v0/live/sessions/livefixture")).toMatchObject({ status: 404 });
    }, 30000);
});
