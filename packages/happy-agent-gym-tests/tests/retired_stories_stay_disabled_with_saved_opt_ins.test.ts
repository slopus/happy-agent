import { createAgentGym, runGymSql, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

it("keeps Stories retired after old opt-ins and stored Stories survive a restart", async () => {
    const gym = await createAgentGym({
        inference: [
            { content: [{ type: "text", text: "The task is ready." }] },
            { content: [{ type: "text", text: "The bot is ready." }] },
        ],
    });
    running.add(gym);
    await gym.client.saveUserSetting("stories", { value: true });
    const { task } = await gym.client.createTask({ name: "Retirement check" });
    const { bot } = await gym.client.createBot({ name: "Retirement bot" });

    await gym.restart({
        whileStopped: async () => {
            await runGymSql(gym.happyHome, [
                "CREATE TABLE happy_agent_module_stories (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, posted_at INTEGER NOT NULL, record TEXT NOT NULL)",
                "INSERT INTO happy_agent_module_stories VALUES ('keepstory', 9999999999999, 1, '{\"preserve\":true}')",
                "INSERT INTO happy_agent_migrations VALUES ('stories-v2', '001-stories', 0)",
                `INSERT INTO happy_agent_module_bot_settings (bot_agent_id, settings_json, version, updated_at)
                 VALUES ('${bot.agent.id}', '{"allowedSecretIds":null,"crossWorkspace":true,"compute":{"type":"host"},"stories":true}', 1, 1)`,
            ]);
        },
    });

    expect((await gym.client.getUserSetting("stories")).setting.value).toBe(true);
    expect((await gym.client.getHealth()).capabilities?.["storyFeed"]).toBeUndefined();
    expect((await gym.http.get("/v0/bootstrap/desktop")).body).toMatchObject({
        storiesEnabled: false,
        stories: [],
    });
    const before = (await gym.client.getBot(bot.id)).bot;
    expect(before.stories).toBe(false);
    const after = (
        await gym.client.renameBot(bot.id, { stories: true }, { ifMatch: before.version })
    ).bot;
    expect(after).toEqual(before);

    for (const [method, path] of [
        ["GET", "/v0/stories"],
        ["POST", "/v0/stories"],
        ["GET", "/v0/stories/keepstory/media"],
        ["GET", "/v0/stories/keepstory/round"],
        ["GET", "/v0/stories/keepstory/layers/round"],
        ["GET", "/v0/stories/keepstory/replies"],
        ["POST", "/v0/stories/keepstory/replies"],
        ["POST", "/v0/stories/keepstory/repost"],
        ["POST", "/v0/stories/keepstory/seen"],
        ["DELETE", "/v0/stories/keepstory"],
    ] as const) {
        expect(await gym.raw.request(method, path)).toMatchObject({
            status: 404,
            body: { code: "not_found" },
        });
    }

    for (const sessionId of [task.agent.id, bot.agent.id]) {
        await gym.send("Check the shipped visual update.", { sessionId });
        const request = gym.inference.requests.findLast((r) => r.sessionId === sessionId)!;
        for (const name of ["post_story", "list_stories", "delete_story"])
            expect(
                JSON.stringify({ tools: request.tools, instructions: request.instructions }),
            ).not.toContain(name);
    }
    const events = (await gym.client.getEvents()).events.map((event) => event.type);
    expect(events).not.toContain("story.changed");
    expect(events).not.toContain("story.removed");

    await gym.restart({
        whileStopped: async () => {
            await runGymSql(gym.happyHome, [
                "CREATE TABLE retirement_checks (ok INTEGER CHECK (ok = 1))",
                "INSERT INTO retirement_checks SELECT COUNT(*) FROM happy_agent_module_stories WHERE id = 'keepstory' AND record = '{\"preserve\":true}'",
                "INSERT INTO retirement_checks SELECT COUNT(*) FROM happy_agent_migrations WHERE module_key = 'stories-v2' AND migration_key = '001-stories'",
            ]);
        },
    });
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 30_000);
