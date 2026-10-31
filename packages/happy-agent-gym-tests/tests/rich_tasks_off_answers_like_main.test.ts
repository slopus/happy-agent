import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import * as published from "happy-agent-client-0.0.136";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Recorded once from main (b5729a62c) by running this file there with
 * HAPPY_RICH_TASKS_RECORD=1; see the fixture's `recordedFrom`.
 */
const FIXTURE = join(import.meta.dirname, "fixtures/rich_tasks_off_on_main.json");
const RECORD = process.env["HAPPY_RICH_TASKS_RECORD"] === "1";
const SETTINGS = ["tasks.rich", "tasks.sections", "tasks.focus"] as const;
/** The optional fields API.md adds for rich tasks, which an older daemon never sends, and protocol 34. */
const ADDED = new Set([
    "icon",
    "children",
    "hidden",
    "sections",
    "taskSections",
    "taskArtifacts",
    "protocol",
]);
const ID = /\b(?:[a-z][a-z0-9]{23}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/g;

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** Ids and paths become placeholders in order of appearance, and times become 0. */
function normalize(value: unknown, root: string): unknown {
    const ids = new Map<string, string>();
    const text = JSON.stringify(value, (key, field: unknown) =>
        ADDED.has(key) ? undefined : typeof field === "number" && field > 1e12 ? 0 : field,
    ).replaceAll(root, "<root>");
    return JSON.parse(
        text.replace(ID, (id) => ids.get(id) ?? ids.set(id, `<${ids.size}>`).get(id)!),
    );
}

describe("with every rich-task setting off", () => {
    it("gives agents main's tools and answers task routes as main does", async () => {
        const latest = new Map<string, GymInferenceRequest>();
        let botAgentId = "";
        const gym = await createAgentGym({
            timeoutMs: 30_000,
            inference: (request) => {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "Parity" }] };
                latest.set(request.sessionId, request);
                const asked = JSON.stringify(request.messages.at(-1));
                if (request.sessionId === botAgentId && asked.includes("Make a helper")) {
                    const args = {
                        title: "Helper",
                        text: "Say hello.",
                        model: gym.selection.modelId,
                        effort: gym.selection.effort,
                    };
                    return {
                        content: [{ type: "tool_call", name: "create_subtask", arguments: args }],
                    };
                }
                return { content: [{ type: "text", text: "Done." }] };
            },
        });
        running.add(gym);
        // The gym's throwaway home folder, which holds the installation and the workspace.
        const root = dirname(gym.happyHome);
        const bots = (await gym.client.listBots()).bots;
        const happy = bots.find((bot) => bot.username === "chief_of_staff")!.agent.id;
        botAgentId = (await gym.client.createBot({ name: "Parity bot" })).bot.agent.id;
        const task = (await gym.client.createTask({ name: "Parity A" })).task;
        await gym.send("Make a helper.", { sessionId: botAgentId });
        const subtask = await gym.waitUntil(
            async () => (await gym.client.getAgent(botAgentId)).agent.subtasks?.[0]?.id,
            "the helper subtask",
        );
        const agents = { task: task.agent.id, bot: botAgentId, subtask, happy };
        const toolSets = async () => {
            const sets: Record<string, Record<string, string>> = {};
            for (const [kind, agentId] of Object.entries(agents)) {
                await gym.send("Hello.", { sessionId: agentId });
                const tools = latest.get(agentId)!.tools.map((tool) => {
                    const shape = normalize([tool.description, tool.parameters], root);
                    const hash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
                    return [tool.name, hash.slice(0, 16)] as const;
                });
                sets[kind] = Object.fromEntries(tools.sort(([a], [b]) => (a < b ? -1 : 1)));
            }
            return sets;
        };
        const offTools = await toolSets();

        // Ordinary actions: create, rename, reorder, archive.
        const cursor = (await gym.client.getEvents()).latestCursor;
        const b = (await gym.client.createTask({ name: "Parity B" })).task;
        const c = (await gym.client.createTask({ name: "Parity C" })).task;
        const version = async (id: string) => ({
            ifMatch: (await gym.client.getTask(id)).task.version,
        });
        const patched = await gym.client.renameTask(
            task.id,
            { name: "Parity A2" },
            await version(task.id),
        );
        await gym.client.reorderTask(c.id, { afterId: task.id });
        await gym.client.archiveTask(b.id, await version(b.id));
        const events = (await gym.client.getEvents({ after: cursor, limit: 1_000 })).events;
        const tasks = await gym.http.ok("GET", "/v0/tasks?scope=joined");
        const bootstrap = await gym.http.ok("GET", "/v0/bootstrap/desktop");
        expect(Value.Check(published.taskListResponseSchema, tasks)).toBe(true);
        expect(Value.Check(published.taskResponseSchema, patched)).toBe(true);
        const recorded = {
            tools: offTools,
            ...(normalize(
                {
                    tasks,
                    patched,
                    bootstrap,
                    events: events.filter((e) => e.type.startsWith("task.")),
                },
                root,
            ) as object),
        };
        if (RECORD) {
            const fixture = { recordedFrom: "b5729a62c", ...recorded };
            await writeFile(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
            return;
        }
        // The fixture is main's raw recording; the same normalizing drops what API.md added since.
        const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as unknown;
        const { recordedFrom: _from, ...main } = normalize(fixture, root) as {
            recordedFrom: string;
            tools: Record<string, Record<string, string>>;
        };
        // API.md: with every setting off, only set_status is withheld from what main gives.
        const mainTools = (rich: boolean) =>
            Object.fromEntries(
                Object.entries(main.tools).map(([kind, tools]) => {
                    const { set_status: status, ...others } = tools;
                    return [kind, rich && status !== undefined ? tools : others];
                }),
            );
        expect(recorded).toEqual({ ...main, tools: mainTools(false) });

        for (let bits = 1; bits < 8; bits += 1) {
            for (const [index, key] of SETTINGS.entries()) {
                await gym.client.saveUserSetting(key, { value: ((bits >> index) & 1) === 1 });
            }
            expect(await toolSets(), `settings ${String(bits)}`).toEqual(
                mainTools((bits & 1) === 1),
            );
        }
        expect(gym.errors).toEqual([]);
    }, 240_000);
});
