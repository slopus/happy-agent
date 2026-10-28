import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

type PermissionMode = "read_only" | "workspace_write" | "auto" | "full_access";

const LABELS: Record<PermissionMode, string> = {
    read_only: "Read only",
    workspace_write: "Workspace write",
    auto: "Auto",
    full_access: "Full access",
};

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A bot whose turns run whatever tool calls the scenario scripts for its next message. */
async function harness() {
    const scripted = new Map<string, { marker: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            const next = scripted.get(request.sessionId);
            if (next !== undefined && JSON.stringify(request.messages).includes(next.marker)) {
                scripted.delete(request.sessionId);
                return next.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
    let index = 0;

    /** Have the bot, running in `mode`, make these calls in one turn and return their results. */
    async function inMode(
        mode: PermissionMode,
        calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[],
    ) {
        const marker = `permission_probe_${++index}`;
        const callIds = calls.map((_, position) => `${marker}_${position}`);
        scripted.set(bot.agent.id, {
            marker,
            turn: {
                content: calls.map((call, position) => ({
                    type: "tool_call" as const,
                    name: call.name,
                    arguments: call.arguments,
                    callId: callIds[position]!,
                })),
            },
        });
        await gym.send(`Run the probe ${marker}.`, {
            sessionId: bot.agent.id,
            permissionMode: mode,
        });
        return await gym.waitUntil(async () => {
            const results = callIds.map((callId) =>
                gym.inference.toolResults().find((result) => result.callId === callId),
            );
            return results.every((result) => result !== undefined) ? results : undefined;
        }, "the probe's tool results");
    }

    const model = {
        model: gym.selection.modelId,
        effort: gym.selection.effort,
        provider: gym.selection.providerId,
    };
    const collaborator = (title: string, flags: Record<string, boolean> = {}) => ({
        name: "create_agent",
        arguments: { ...model, title, text: `Work on ${title}.`, ...flags },
    });
    const subtask = (title: string, flags: Record<string, boolean> = {}) => ({
        name: "create_subtask",
        arguments: { ...model, title, text: `Work on ${title}.`, ...flags },
    });

    /** The mode a created child reports and the one its first inference was told it runs in. */
    async function childMode(agentId: string) {
        const request = await gym.waitUntil(
            async () => gym.inference.requests.find((item) => item.sessionId === agentId),
            "the child's first inference",
        );
        const told = /You are working in (.+?) mode\./.exec(request.instructions)?.[1];
        const { mode } = await gym.client.getAgentMode(agentId);
        return { told, recorded: mode?.permissionMode };
    }

    return { gym, bot, inMode, collaborator, subtask, childMode };
}

const createdAgentId = (text: string) =>
    /Created (?:collaborator|subtask) ([a-z0-9]+)/.exec(text)?.[1] ??
    (() => {
        throw new Error(`No agent was created: ${text}`);
    })();

describe("agent-created children and the creator's permission mode", () => {
    it.each(["read_only", "workspace_write", "auto", "full_access"] as const)(
        "runs a collaborator and a subtask created by a %s agent in that mode",
        async (mode) => {
            const { gym, inMode, collaborator, subtask, childMode } = await harness();

            const [agent, task] = await inMode(mode, [
                collaborator("Hidden helper"),
                subtask("Visible helper"),
            ]);

            for (const result of [agent!, task!]) {
                expect(await childMode(createdAgentId(result.text))).toEqual({
                    told: LABELS[mode],
                    recorded: mode,
                });
            }
            expect(gym.errors).toEqual([]);
        },
        60_000,
    );

    it("lets read_only narrow a child and full_mode widen it only from Full access", async () => {
        const { gym, bot, inMode, collaborator, subtask, childMode } = await harness();

        const [narrowed, full, fullTask] = await inMode("full_access", [
            collaborator("Narrowed helper", { read_only: true }),
            collaborator("Full helper", { full_mode: true }),
            subtask("Full subtask", { full_mode: true }),
        ]);
        expect(await childMode(createdAgentId(narrowed!.text))).toEqual({
            told: "Read only",
            recorded: "read_only",
        });
        for (const result of [full!, fullTask!]) {
            expect(await childMode(createdAgentId(result.text))).toEqual({
                told: "Full access",
                recorded: "full_access",
            });
        }

        const refused = await inMode("auto", [
            collaborator("Refused helper", { full_mode: true }),
            subtask("Refused subtask", { full_mode: true }),
            collaborator("Contradictory helper", { read_only: true, full_mode: true }),
        ]);
        expect(refused.map((result) => result!.text)).toEqual([
            expect.stringContaining(
                "full_mode is allowed only while you are in Full access yourself",
            ),
            expect.stringContaining(
                "full_mode is allowed only while you are in Full access yourself",
            ),
            expect.stringContaining("Set read_only or full_mode, not both."),
        ]);
        const children = (await gym.client.getAgentActivity(bot.agent.id)).subagents.map(
            (child) => child.title,
        );
        expect(children).not.toContain("Refused helper");
        expect(children).not.toContain("Refused subtask");
        expect(children).not.toContain("Contradictory helper");
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
