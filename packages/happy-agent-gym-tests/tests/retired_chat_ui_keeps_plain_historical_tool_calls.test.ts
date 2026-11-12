import { createAgentGym, runGymSql, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

it("retires chat UI while retaining completed historical calls across restart", async () => {
    const gym = await createAgentGym({
        inference: [{ content: [{ type: "text", text: "Ready." }] }],
    });
    running.add(gym);
    await gym.send("Check the available tools.");
    expect(gym.inference.lastTools()).not.toContain("show_ui");
    expect(gym.inference.lastTools()).not.toContain("suggest_replies");
    expect((await gym.client.getHealth()).capabilities?.chatUi).toBeUndefined();
    expect(await gym.http.post(`/v0/agents/${gym.defaultSessionId}/actions`, {})).toMatchObject({
        status: 404,
    });

    const page = await gym.client.getMessages(gym.defaultSessionId);
    const assistant = page.runs
        .flatMap((run) => run.messages)
        .find((message) => message.role === "agent");
    expect(assistant).toBeDefined();
    const calls = [
        {
            name: "show_ui",
            id: "ashowhistoricaltoolcalla",
            arguments: { components: [] },
            presentation: { type: "ui", ui: { unknown: true }, items: [] },
        },
        {
            name: "suggest_replies",
            id: "asuggesthistoricalcallaa",
            arguments: { options: ["Yes"] },
            presentation: { type: "quick_replies", options: ["Yes"], future: true },
        },
    ];
    const blocks = calls.flatMap((call) => [
        { type: "tool_call", callId: call.id, name: call.name, arguments: call.arguments },
        {
            type: "tool_result",
            callId: call.id,
            toolName: call.name,
            output: "Saved result",
            presentation: call.presentation,
        },
    ]);
    const encoded = JSON.stringify(blocks).replaceAll("'", "''");
    await gym.restart({
        whileStopped: async () =>
            await runGymSql(gym.happyHome, [
                `UPDATE happy_agent_module_history SET message_json = json_set(message_json, '$.blocks', json('${encoded}')) WHERE record_id = '${assistant!.id}'`,
            ]),
    });

    // Requests without the old feature header used to replace these calls with fallback text.
    const loaded = await gym.raw.request("GET", `/v0/agents/${gym.defaultSessionId}/messages`);
    expect(loaded.status).toBe(200);
    for (const call of calls) {
        expect(JSON.stringify(loaded.body)).toContain(`"name":"${call.name}"`);
    }
    const history = await gym.client.getMessages(gym.defaultSessionId);
    const saved = history.runs
        .flatMap((run) => run.messages)
        .find((message) => message.id === assistant!.id);
    expect(saved?.content).toEqual(
        calls.map((call) => ({
            type: "tool_call",
            id: call.id,
            name: call.name,
            status: "completed",
            arguments: call.arguments,
            result: { output: "Saved result" },
            presentation: call.presentation,
        })),
    );
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 60_000);
