import { readFileSync } from "node:fs";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const fixtures = new URL("../../../docs/genui/", import.meta.url);
const { root } = JSON.parse(
    readFileSync(new URL("examples/01-stats.genui.json", fixtures), "utf8"),
);
const { fallback: _fallback, ...compiled } = JSON.parse(
    readFileSync(new URL("render/compiled/01-stats.render.json", fixtures), "utf8"),
);

it("presents existing Gen UI directly in Read only chat, persists it, and never creates an artifact", async () => {
    const gym = await createAgentGym({
        permissionMode: "read_only",
        inference: [
            { content: [{ type: "tool_call", name: "gen_ui", arguments: root }] },
            { content: [{ type: "text", text: "Revenue grew 18%." }] },
        ],
    });
    running.add(gym);
    const before = await gym.client.listArtifacts();
    await gym.send("Show Q3 directly in this conversation.");
    const page = await gym.client.getMessages(gym.defaultSessionId, { omitToolData: true });
    const call = page.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => message.content)
        .find((block) => block.type === "tool_call" && block.name === "gen_ui");
    expect(call).toMatchObject({
        status: "completed",
        arguments: root,
        presentation: { type: "gen_ui", document: compiled },
    });
    expect(JSON.stringify(gym.inference.toolResults())).not.toContain("genuiRender");
    expect((await gym.client.listArtifacts()).artifacts).toEqual(before.artifacts);
    const events = await gym.sessionEvents();
    expect(JSON.stringify(events)).toContain('"type":"gen_ui"');
    const changes = await gym.client.getEvents({ after: before.cursor, limit: 200 });
    expect(changes.events.some((event) => event.type.startsWith("artifact."))).toBe(false);
    await gym.restart();
    const reloaded = await gym.client.getMessages(gym.defaultSessionId, { omitToolData: true });
    expect(
        reloaded.runs
            .flatMap((run) => run.messages)
            .flatMap((message) => message.content)
            .find((block) => block.type === "tool_call" && block.name === "gen_ui"),
    ).toEqual(call);
    expect((await gym.client.listArtifacts()).artifacts).toEqual(before.artifacts);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 60_000);

it("rejects invalid Gen UI without a presentation or a catalog mutation and continues", async () => {
    const gym = await createAgentGym({
        inference: [
            {
                content: [
                    {
                        type: "tool_call",
                        name: "gen_ui",
                        arguments: {
                            type: "stat",
                            label: "Revenue",
                            value: 12,
                        },
                    },
                ],
            },
            { content: [{ type: "text", text: "The view was invalid." }] },
        ],
    });
    running.add(gym);
    await gym.send("Show an invalid view.");
    const page = await gym.client.getMessages(gym.defaultSessionId);
    const call = page.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => message.content)
        .find((block) => block.type === "tool_call" && block.name === "gen_ui");
    expect(call).toMatchObject({ status: "failed" });
    expect(call).not.toHaveProperty("presentation");
    expect(JSON.stringify(call)).toContain("root<stat>.value");
    expect((await gym.client.listArtifacts()).artifacts).toEqual([]);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 60_000);
