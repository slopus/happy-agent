import type { AgentConfig, AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const OPUS = { model: "opus-5", effort: "high", provider: "claude" } as const;
const ON_CODEX = { provider: "codex", model: "gpt-5.6-sol" } as const;

/**
 * A bot coordinating two subtasks, one with a subtask of its own, beside an ordinary hidden
 * collaborator. Collaboration is a stand-in that resolves every choice to Opus and records what
 * it was asked to deliver.
 */
function fixture() {
    const ctx = moduleDatabase([], "subtask-model-switch").context;
    const configs = new Map<string, AgentConfig>([
        ["botagent", { metadata: { version: 1 } }],
        ["subtaskone", { metadata: { subtask: true, version: 1 } }],
        ["subtasktwo", { metadata: { subtask: true, version: 1 } }],
        ["nested", { metadata: { subtask: true, version: 1 } }],
        ["hidden", { metadata: { title: "Researcher" } }],
        ["archived", { metadata: { subtask: true, version: 2, archivedAt: 1 } }],
        ["loosebot", { metadata: { version: 1 } }],
    ]);
    const parents = new Map<string, string | null>([
        ["botagent", null],
        ["subtaskone", "botagent"],
        ["subtasktwo", "botagent"],
        ["nested", "subtaskone"],
        ["hidden", "botagent"],
        ["archived", "botagent"],
        ["loosebot", null],
    ]);
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
        childOf: async (_ctx: Context, id: string) =>
            [...parents].flatMap(([child, parent]) => (parent === id ? [child] : [])),
    };
    const collaboration = {
        selectAgentModel: vi.fn(() => ({ model: "opus-5", effort: "high", provider: "claude" })),
        availableModels: () => [
            {
                providerId: "claude",
                id: "opus-5",
                name: "Opus 5",
                effortLevels: ["high"],
                defaultEffort: "high",
            },
        ],
        shownAgentOptions: async () => "OPTIONS-LISTING",
        sendMessage: vi.fn(async () => undefined),
    };
    const module = new SubtasksModule(
        {
            forAgent: async (_ctx: Context, id: string) =>
                id === "botagent" ? { status: "active" } : undefined,
        } as never,
        { forAgent: async () => undefined } as never,
        collaboration as never,
        { onEventTransactional: vi.fn(), get: vi.fn() } as never,
        { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() } as never,
        {} as never,
        {} as never,
    );
    const hooks = module.beforeStart(ctx, agents as never);
    /** The tools Agent Base builds for one coordinator on the Codex route. */
    const toolsOf = async (agentId: string): Promise<readonly AnyAgentTool[]> =>
        await hooks.tools!(ctx, {
            agent: { id: agentId, ...ON_CODEX, permissionMode: "auto" },
            kv: {},
        } as never);
    return { ctx, module, collaboration, hooks, toolsOf };
}

describe("switching a subtask's model", () => {
    it("sends the subtask a message from its coordinator carrying the new model", async () => {
        const { ctx, module, collaboration } = fixture();

        const result = await module.switchModel(
            ctx,
            "botagent",
            { agentId: "subtaskone", ...OPUS },
            "call1",
            ON_CODEX,
        );

        expect(result).toEqual({
            agentId: "subtaskone",
            model: "opus-5",
            modelName: "Opus 5",
            effort: "high",
            provider: "claude",
        });
        expect(collaboration.selectAgentModel).toHaveBeenCalledWith(OPUS, ON_CODEX);
        expect(collaboration.sendMessage).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            "botagent",
            {
                toAgentId: "subtaskone",
                explanation: "Switched model to Opus 5",
                text: "I switched you to Opus 5 at high effort. Carry on with your current work; if you have none, reply in one line that you are ready.",
            },
            "call1",
            OPUS,
            ON_CODEX,
        );
    });

    it("lets a subtask switch its own direct subtask", async () => {
        const { ctx, module, collaboration } = fixture();

        await module.switchModel(ctx, "subtaskone", { agentId: "nested", ...OPUS }, "call1");

        expect(collaboration.sendMessage).toHaveBeenCalledOnce();
    });

    it.each([
        ["a sibling", "subtaskone", "subtasktwo"],
        ["a grandchild", "botagent", "nested"],
        ["its own coordinator", "subtaskone", "botagent"],
        ["an ordinary hidden collaborator", "botagent", "hidden"],
        ["another root's subtask", "loosebot", "subtaskone"],
        ["an unknown agent", "botagent", "nobody"],
    ])("refuses to switch %s", async (_label, actor, target) => {
        const { ctx, module, collaboration } = fixture();

        await expect(
            module.switchModel(ctx, actor, { agentId: target, ...OPUS }, "call1"),
        ).rejects.toThrow(
            "Only a subtask's direct coordinating bot, task, or subtask may switch its model.",
        );
        expect(collaboration.sendMessage).not.toHaveBeenCalled();
    });

    it("refuses to switch an archived subtask", async () => {
        const { ctx, module, collaboration } = fixture();

        await expect(
            module.switchModel(ctx, "botagent", { agentId: "archived", ...OPUS }, "call1"),
        ).rejects.toThrow(SubtaskInputError);
        expect(collaboration.sendMessage).not.toHaveBeenCalled();
    });

    it("refuses a malformed request before reading anything", async () => {
        const { ctx, module, collaboration } = fixture();

        await expect(
            module.switchModel(
                ctx,
                "botagent",
                { agentId: "subtaskone", model: "opus-5", effort: "huge" } as never,
                "call1",
            ),
        ).rejects.toThrow("The subtask model switch request is invalid.");
        expect(collaboration.selectAgentModel).not.toHaveBeenCalled();
    });

    it("passes a refused choice back without delivering anything", async () => {
        const { ctx, module, collaboration } = fixture();
        collaboration.selectAgentModel.mockImplementationOnce(() => {
            throw new Error('Model "nope" is not available for collaborators.');
        });

        await expect(
            module.switchModel(
                ctx,
                "botagent",
                { agentId: "subtaskone", model: "nope", effort: "high" },
                "call1",
            ),
        ).rejects.toThrow("not available");
        expect(collaboration.sendMessage).not.toHaveBeenCalled();
    });
});

describe("subtask model switch tool", () => {
    it("is offered to coordinators beside create and archive, under the call's identity", async () => {
        const { ctx, toolsOf, collaboration } = fixture();
        const tools = await toolsOf("botagent");
        expect(tools.map((tool) => tool.name)).toEqual([
            "create_subtask",
            "archive_subtask",
            "switch_subtask_model",
        ]);
        const tool = tools.find((candidate) => candidate.name === "switch_subtask_model")!;
        const input = { agentId: "subtaskone", ...OPUS };

        expect(tool.durable).toBe(true);
        expect(tool.transactional).toBe(true);
        expect(tool.shouldReviewInAutoMode(input, ctx)).toBe(false);
        expect(tool.description).toContain("Only its coordinating bot, task, or subtask");
        expect(tool.description).toContain("same options as create_subtask");
        expect(tool.description).toContain("send_agent_message with the same model fields");
        const result = await tool.execute(ctx, input, { id: "call1" } as never);

        expect(collaboration.sendMessage).toHaveBeenCalledWith(
            expect.anything(),
            "botagent",
            expect.objectContaining({ toAgentId: "subtaskone" }),
            "call1",
            OPUS,
            ON_CODEX,
        );
        expect(tool.toLLM(result as never)).toEqual([
            {
                type: "text",
                text: "Switched subtask subtaskone to Opus 5 (opus-5 via claude) at high effort. It changes model when it reads your message; anything it says arrives as a message.",
            },
        ]);
    });

    it("tells coordinators and subtasks how to switch a subtask's model", async () => {
        const { ctx, hooks } = fixture();

        for (const agentId of ["botagent", "subtaskone"]) {
            const instructions = await hooks.instructions!(ctx, {
                agent: { id: agentId },
            } as never);
            expect(instructions).toContain(
                "Switch a subtask's model with switch_subtask_model only when its model is failing or wrong for the work.",
            );
        }
    });
});
