import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";
import { sidebarGym } from "./support/sidebarGym.js";

const SETTING = "happy-desktop.experiments.stemCells";
const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("keeps the enabled state isolated between two people", async () => {
    const { gym, alice, bob, aliceHttp, bobHttp } = await surfaceTeamClients({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const sessions = () => [
        ...new Set(
            gym.inference.requests
                .filter((request) => request.instructions.includes("You are the Focus Agent"))
                .map((request) => request.sessionId),
        ),
    ];
    await alice.saveUserSetting(SETTING, { value: true });
    await bobHttp.ok("GET", "/v0/spaces/sidebar");
    await aliceHttp.ok("GET", "/v0/spaces/sidebar");
    const first = await gym.waitUntil(() => sessions()[0], "Alice's organiser");
    await gym.waitUntil(
        async () => ((await alice.getAgent(first)).agent.status !== "working" ? true : undefined),
        "Alice's opening to finish",
    );
    expect(sessions()).toHaveLength(1);
    await bob.saveUserSetting(SETTING, { value: true });
    await bobHttp.ok("GET", "/v0/spaces/sidebar");
    const second = await gym.waitUntil(
        () => sessions().find((id) => id !== first),
        "Bob's separate organiser",
    );
    await gym.waitUntil(
        async () => ((await bob.getAgent(second)).agent.status !== "working" ? true : undefined),
        "Bob's opening to finish",
    );
    await bob.saveUserSetting(SETTING, { value: false });
    const count = (id: string) =>
        gym.inference.requests.filter((request) => request.sessionId === id).length;
    const aliceBefore = count(first);
    const bobBefore = count(second);
    await bobHttp.ok("POST", "/v0/spaces/tidy", {});
    await aliceHttp.ok("POST", "/v0/spaces/tidy", {});
    await gym.waitUntil(
        () => (count(first) > aliceBefore ? true : undefined),
        "Alice to keep prioritizing",
    );
    expect(count(second)).toBe(bobBefore);
    expect((await alice.getUserSetting(SETTING)).setting.value).toBe(true);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("discards pending organisation edits when disabled, including after re-enabling", async () => {
    const h = await sidebarGym();
    running.add(h.gym);
    await h.read();
    await h.unseed();
    const before = await h.read();
    // The edit stays queued while Prioritizing's turn is still open.
    const release = h.holdTurn();
    await h.edit(
        before.html.replace("</nav>", '<happy-section id="releases" label="Releases"/></nav>'),
    );
    await h.gym.client.saveUserSetting(SETTING, { value: null });
    release();
    await h.settle();
    expect((await h.read()).html).toBe(before.html);
    await h.gym.client.saveUserSetting(SETTING, { value: true });
    await h.gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
    expect((await h.read()).html).toBe(before.html);
    expect(h.gym.errors).toEqual([]);
}, 30_000);

it("keeps Prioritizing off by default and still names ordinary tasks and bots", async () => {
    const gym = await createAgentGym({
        inference: (request) => ({
            content: [
                {
                    type: "text",
                    text: request.sessionId.startsWith("naming:")
                        ? "<title>Release Notes</title>"
                        : "Done.",
                },
            ],
        }),
    });
    running.add(gym);
    await gym.http.ok("GET", "/v0/spaces/sidebar");
    for (const value of [false, "true", null]) {
        await gym.client.saveUserSetting(SETTING, { value });
        await gym.http.ok("GET", "/v0/spaces/sidebar");
        await gym.http.ok("POST", "/v0/spaces/tidy", {});
    }
    const task = (await gym.client.createTask({})).task;
    const bot = (await gym.client.createBot({})).bot;
    for (const work of [task, bot]) {
        await gym.send("Write release notes.", { sessionId: work.agent.id });
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(work.agent.id)).agent.title === "Release Notes"
                    ? true
                    : undefined,
            "normal naming while Stem Cells is off",
        );
    }
    expect(
        gym.inference.requests.some((request) =>
            request.instructions.includes("You are the Focus Agent"),
        ),
    ).toBe(false);
    expect(gym.errors).toEqual([]);
}, 30_000);

it("stops a running Prioritizing on disable and does not brief it again", async () => {
    const gym = await createAgentGym({
        inference(request) {
            return {
                delayMs: request.instructions.includes("You are the Focus Agent") ? 60_000 : 0,
                content: [{ type: "text", text: "Done." }],
            };
        },
    });
    running.add(gym);
    await gym.client.saveUserSetting(SETTING, { value: true });
    await gym.http.ok("GET", "/v0/spaces/sidebar");
    const manager = await gym.waitUntil(
        () =>
            gym.inference.requests.find((request) =>
                request.instructions.includes("You are the Focus Agent"),
            )?.sessionId,
        "enabled Prioritizing to begin",
    );
    await gym.client.saveUserSetting(SETTING, { value: null });
    await gym.waitUntil(
        async () =>
            (await gym.client.getAgent(manager)).agent.status !== "working" ? true : undefined,
        "disabled Prioritizing to stop",
    );
    const count = gym.inference.requests.filter((request) =>
        request.instructions.includes("You are the Focus Agent"),
    ).length;
    await gym.http.ok("POST", "/v0/spaces/tidy", {});
    await gym.http.ok("POST", "/v0/spaces/attention", { state: "calm" });
    await gym.http.ok("GET", "/v0/spaces/sidebar");
    await gym.send("An unrelated request.");
    expect(
        gym.inference.requests.filter((request) =>
            request.instructions.includes("You are the Focus Agent"),
        ),
    ).toHaveLength(count);
    expect(gym.errors).toEqual([]);
}, 30_000);
