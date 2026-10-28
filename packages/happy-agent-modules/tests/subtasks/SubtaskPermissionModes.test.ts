import {
    withAgentContext,
    withAgentPermissionMode,
    type AgentConfig,
    type AgentPermissionMode,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SUBTASK_START_FUNCTION } from "../../sources/subtasks/Subtask.js";
import { SubtasksModule, type CreateSubtaskInput } from "../../sources/subtasks/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const input: CreateSubtaskInput = {
    title: "Patch login",
    text: "Fix the redirect loop.",
    model: "test-model",
    effort: "high",
};

const PERMISSION_MODES: readonly AgentPermissionMode[] = [
    "read_only",
    "workspace_write",
    "auto",
    "full_access",
];

/** A bot that may create shared-folder subtasks, with the durable start run in place. */
function fixture() {
    const ctx = moduleDatabase([], "subtask-permission-modes").context;
    const configs = new Map<string, AgentConfig>([
        ["botagent", { metadata: { version: 1 } } as AgentConfig],
    ]);
    const parents = new Map<string, string | null>([["botagent", null]]);
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
        childOf: async (_ctx: Context, id: string) =>
            [...parents].flatMap(([child, parent]) => (parent === id ? [child] : [])),
        create: async (
            _ctx: Context,
            config: AgentConfig,
            options: { id: string; parent: string },
        ) => {
            configs.set(options.id, config);
            parents.set(options.id, options.parent);
            return { id: options.id };
        },
    };
    const durableFunctions = { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() };
    const collaboration = {
        selectAgentModel: () => ({ model: "test-model", effort: "high", provider: "codex" }),
        shownAgentOptions: async () => "OPTIONS-LISTING",
        createAgent: vi.fn(async () => ({ agentId: "created" })),
    };
    const module = new SubtasksModule(
        {
            forAgent: async (_ctx: Context, id: string) =>
                id === "botagent" ? { status: "active" } : undefined,
        } as never,
        { forAgent: async () => undefined } as never,
        collaboration as never,
        { onEventTransactional: vi.fn(), get: vi.fn() } as never,
        durableFunctions as never,
        {} as never,
        {} as never,
    );
    const hooks = module.beforeStart(ctx, agents as never);
    /** The mode the durable start of one subtask was recorded with. */
    const startMode = (agentId: string): unknown =>
        durableFunctions.invoke.mock.calls
            .map(([, call]) => call as { arguments: { agentId: string; permissionMode?: unknown } })
            .find((call) => call.arguments.agentId === agentId)?.arguments.permissionMode;
    /** Run the durable start the way Durable Functions would, on a context naming no agent. */
    const start = async (agentId: string): Promise<void> => {
        const registered = durableFunctions.register.mock.calls
            .map(([definition]) => definition)
            .find((definition) => definition.name === SUBTASK_START_FUNCTION);
        const invoked = durableFunctions.invoke.mock.calls
            .map(([, call]) => call)
            .find((call) => call.arguments.agentId === agentId);
        await registered.executor(ctx, { arguments: invoked.arguments });
    };
    /** create_subtask as Agent Base builds it for a bot whose persistent mode is `mode`. */
    const createTool = async (mode: AgentPermissionMode): Promise<AnyAgentTool> => {
        const tools = await hooks.tools!(ctx, {
            agent: { id: "botagent", provider: "codex", model: undefined, permissionMode: mode },
            kv: {},
        } as never);
        const tool = tools.find((candidate) => candidate.name === "create_subtask");
        if (tool === undefined) throw new Error("The create_subtask tool was not offered.");
        return tool;
    };
    const call = (agentId: string) =>
        ({ id: agentId, kv: { getOrCreate: async () => agentId } }) as never;
    return { ctx, configs, module, collaboration, startMode, start, createTool, call };
}

describe("subtask permission modes", () => {
    it.each(PERMISSION_MODES)(
        "runs a subtask in its coordinator's %s mode through its opening task",
        async (mode) => {
            const { ctx, createTool, call, startMode, start, collaboration } = fixture();

            await (await createTool(mode)).execute(ctx, input, call("child"));
            expect(startMode("child")).toBe(mode);

            await start("child");
            expect(collaboration.createAgent).toHaveBeenCalledExactlyOnceWith(
                expect.anything(),
                "botagent",
                expect.not.objectContaining({ read_only: expect.anything() }),
                "child",
                { creatorPermissionMode: mode },
            );
        },
    );

    it.each(PERMISSION_MODES)("lets a %s coordinator hand a subtask Read only", async (mode) => {
        const { ctx, createTool, call, startMode, start, collaboration } = fixture();

        await (await createTool(mode)).execute(ctx, { ...input, read_only: true }, call("child"));
        expect(startMode("child")).toBe("read_only");

        await start("child");
        expect(collaboration.createAgent).toHaveBeenCalledWith(
            expect.anything(),
            "botagent",
            expect.not.objectContaining({ read_only: true }),
            "child",
            { creatorPermissionMode: "read_only" },
        );
    });

    it("lets a Full access coordinator ask for Full access", async () => {
        const { ctx, createTool, call, startMode } = fixture();

        await (
            await createTool("full_access")
        ).execute(ctx, { ...input, full_mode: true }, call("child"));

        expect(startMode("child")).toBe("full_access");
    });

    it.each(["read_only", "workspace_write", "auto"] as const)(
        "refuses full_mode from a %s coordinator before anything is created",
        async (mode) => {
            const { ctx, configs, createTool, call, startMode } = fixture();

            await expect(
                (await createTool(mode)).execute(ctx, { ...input, full_mode: true }, call("child")),
            ).rejects.toThrow("full_mode is allowed only while you are in Full access yourself");

            expect(configs.has("child")).toBe(false);
            expect(startMode("child")).toBeUndefined();
        },
    );

    it("refuses read_only and full_mode together", async () => {
        const { ctx, configs, createTool, call } = fixture();

        await expect(
            (await createTool("full_access")).execute(
                ctx,
                { ...input, read_only: true, full_mode: true },
                call("child"),
            ),
        ).rejects.toThrow("Set read_only or full_mode, not both.");
        expect(configs.has("child")).toBe(false);
    });

    it("does not count Full access an Auto review lent the call as the coordinator's mode", async () => {
        const { ctx, createTool, call, startMode } = fixture();
        const tool = await createTool("auto");
        const elevated = withAgentPermissionMode(
            withAgentContext(ctx, { id: "botagent", provider: "codex", permissionMode: "auto" }),
            "full_access",
        );

        await expect(
            tool.execute(elevated, { ...input, full_mode: true }, call("refused")),
        ).rejects.toThrow("you are in Auto");
        await tool.execute(elevated, input, call("child"));

        expect(startMode("child")).toBe("auto");
    });

    it("gives a subtask a module creates on its own the product default", async () => {
        const { ctx, module, startMode } = fixture();

        await module.create(ctx, "botagent", input, "voice");

        expect(startMode("voice")).toBe("auto");
    });
});
