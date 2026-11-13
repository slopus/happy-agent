import {
    AgentKV,
    ensureAgentDatabaseConnection,
    withAgentPermissionMode,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { afterEach, expect, it, vi } from "vitest";
import { SkillsModule, type GlobalSkillsModule } from "../../sources/skills/index.js";
import { querySkillUsage } from "../../sources/skills/impl/skillUsage.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanups.splice(0)) close();
});

async function fixture() {
    const db = moduleDatabase([], "skill-shortlist");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    cleanups.push(db.close);
    const ctx = db.context;
    const machine = new FakeCompute("/workspace");
    machine.directories.add("/workspace/.git");
    const install = (name: string, description = "Specialized instructions.") => {
        machine.write(
            `/workspace/.agents/skills/${name}/SKILL.md`,
            `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.`,
        );
    };
    for (let i = 0; i < 100; i++) install(`skill-${String(i).padStart(3, "0")}`);
    install("zz-frequent");
    const compute = scriptedComputeModule(async () => machine);
    const module = new SkillsModule(compute);
    const hooks = await resolveModuleHooks(ctx, module);
    const store = new InMemoryPersistence();
    const scope = (id: string): AgentModuleScope => ({
        agent: { id } as never,
        kv: new AgentKV(store, `${id}.agent.`),
        runKV: new AgentKV(store, `${id}.run.`),
        historyKV: new AgentKV(store, `${id}.history.`),
        sharedKV: new AgentKV(store, "shared."),
    });
    const accept = async (scope: AgentModuleScope, userId: string, metadata = {}) => {
        await hooks.messageAcceptedTransact!(ctx, scope, {
            id: "message",
            kind: "send",
            profile: null,
            message: { role: "user", content: [{ type: "text", text: "Use skills." }] },
            metadata: { messageOrigin: "user", userId, ...metadata },
        });
    };
    const read = async (scope: AgentModuleScope, name = "zz-frequent") => {
        const tools = await hooks.tools!(ctx, scope);
        return await tools
            .find((tool) => tool.name === "read_skill")!
            .execute(ctx, { name } as never, undefined as never);
    };
    return { ctx, machine, compute, module, hooks, scope, accept, read, install };
}

it("keeps a durable shortlist stable, learns only successful activations, and isolates people", async () => {
    const f = await fixture();
    const first = f.scope("first");
    await f.accept(first, "alice");
    const initial = await f.hooks.instructions!(f.ctx, first);
    expect(initial.length).toBeLessThanOrEqual(12_000);
    expect(initial).toContain("stable shortlist, not the complete installed catalog");
    expect(initial).not.toContain("<name>zz-frequent</name>");
    await f.read(first);
    await f.read(first);
    await expect(f.read(first, "missing")).rejects.toThrow("Unknown skill");
    await f.module.list(f.ctx, first.agent.id, { query: "skill" });
    expect(await querySkillUsage(f.ctx, first, "user:alice")).toEqual([
        { name: "zz-frequent", count: 1 },
    ]);
    expect(await f.hooks.instructions!(f.ctx, first)).toBe(initial);
    const restored = await resolveModuleHooks(f.ctx, new SkillsModule(f.compute));
    expect(await restored.instructions!(f.ctx, f.scope("first"))).toBe(initial);
    await f.accept(first, "carol");
    await f.read(first);
    expect(await querySkillUsage(f.ctx, first, "user:carol")).toEqual([
        { name: "zz-frequent", count: 1 },
    ]);
    expect(await querySkillUsage(f.ctx, first, "user:alice")).toEqual([
        { name: "zz-frequent", count: 1 },
    ]);
    expect(await f.hooks.instructions!(f.ctx, first)).toBe(initial);

    const next = f.scope("next");
    // Anonymous startup must not freeze the selection before Alice arrives.
    await f.hooks.instructions!(f.ctx, next);
    await f.accept(next, "alice");
    expect(await f.hooks.instructions!(f.ctx, next)).toContain("<name>zz-frequent</name>");
    const other = f.scope("other");
    await f.accept(other, "bob");
    expect(await f.hooks.instructions!(f.ctx, other)).not.toContain("<name>zz-frequent</name>");
    expect(await querySkillUsage(f.ctx, other, "user:bob")).toEqual([]);
});

it("updates selected metadata and removes unavailable entries without promoting new skills", async () => {
    const f = await fixture();
    const scope = f.scope("task");
    await f.accept(scope, "alice");
    const original = await f.hooks.instructions!(f.ctx, scope);
    f.install("skill-000", "Updated selected description.");
    f.install("aaa-new", "Newly installed.");
    const changed = await f.hooks.instructions!(f.ctx, scope);
    expect(changed).toContain("Updated selected description.");
    expect(changed).not.toContain("aaa-new");
    f.machine.files.delete("/workspace/.agents/skills/skill-000/SKILL.md");
    const removed = await f.hooks.instructions!(f.ctx, scope);
    expect(removed).not.toContain("<name>skill-000</name>");
    expect(removed).not.toContain("aaa-new");
    expect(removed.match(/<skill>/g)!.length).toBe(original.match(/<skill>/g)!.length - 1);
    f.machine.write(
        "/workspace/.agents/skills/skill-001/SKILL.md",
        "---\nname: skill-001\ndescription: User only.\ndisable-model-invocation: true\n---\nInstructions.",
    );
    expect(await f.hooks.instructions!(f.ctx, scope)).not.toContain("<name>skill-001</name>");
    await expect(f.read(scope, "skill-001")).rejects.toThrow("only be invoked by the user");
});

it("counts concurrent tasks atomically and does not attribute autonomous work or double-count explicit invocation", async () => {
    const f = await fixture();
    const scopes = Array.from({ length: 12 }, (_, index) => f.scope(`task-${index}`));
    await Promise.all(
        scopes.map(async (scope) => {
            await f.accept(scope, "alice");
            await f.read(scope);
        }),
    );
    expect(await querySkillUsage(f.ctx, scopes[0]!, "user:alice")).toEqual([
        { name: "zz-frequent", count: 12 },
    ]);
    const autonomous = f.scope("autonomous");
    await f.accept(autonomous, "alice", { messageOrigin: "agent" });
    await f.read(autonomous);
    expect(await querySkillUsage(f.ctx, autonomous, "user:alice")).toEqual([
        { name: "zz-frequent", count: 12 },
    ]);
    const explicit = f.scope("explicit");
    await f.accept(explicit, "bob", {
        skillInvocation: {
            content: "Instructions.",
            messageId: "invoke",
            name: "zz-frequent",
            location: "/workspace/.agents/skills/zz-frequent/SKILL.md",
        },
    });
    await f.read(explicit);
    expect(await querySkillUsage(f.ctx, explicit, "user:bob")).toEqual([
        { name: "zz-frequent", count: 1 },
    ]);
});

it("filters a disabled global skill out of a persisted shortlist immediately", async () => {
    const f = await fixture();
    const location = "/home/agent/.agents/skills/aaa-global/SKILL.md";
    f.machine.write(
        location,
        "---\nname: aaa-global\ndescription: Global instructions.\n---\nRead me.",
    );
    vi.spyOn(f.compute, "fileSystemIdentity").mockReturnValue("native-test");
    const unavailable = new Set<string>();
    const management = {
        managesHome: () => true,
        unavailableLocations: async () => new Set(unavailable),
    } as unknown as GlobalSkillsModule;
    const module = new SkillsModule(f.compute, management);
    const hooks = await resolveModuleHooks(f.ctx, module);
    const scope = f.scope("global");
    await f.accept(scope, "alice");
    expect(await hooks.instructions!(f.ctx, scope)).toContain("<name>aaa-global</name>");
    unavailable.add(location);
    expect(await hooks.instructions!(f.ctx, scope)).not.toContain("aaa-global");
    await expect(module.read(f.ctx, scope.agent.id, { name: "aaa-global" })).rejects.toThrow(
        "Unknown skill",
    );
    unavailable.clear();
    expect(await hooks.instructions!(f.ctx, scope)).toContain("<name>aaa-global</name>");
});

it("revalidates permissions without rescanning and reconciles changed precedence at the next catalog boundary", async () => {
    const f = await fixture();
    const scope = f.scope("fast");
    await f.accept(scope, "alice");
    const initial = await f.hooks.instructions!(f.ctx, scope);
    const directoryRead = vi.spyOn(f.machine.fs, "readdirPage");
    expect(await f.hooks.instructions!(f.ctx, scope)).toBe(initial);
    expect(directoryRead).not.toHaveBeenCalled();
    const original = f.machine.fs.readFileBuffer.bind(f.machine.fs);
    vi.spyOn(f.machine.fs, "readFileBuffer").mockImplementation((permissions, path, options) => {
        if (permissions.mode === "read_only")
            return Promise.reject(new Error("Denied by this machine."));
        return original(permissions, path, options);
    });
    expect(
        await f.hooks.instructions!(withAgentPermissionMode(f.ctx, "read_only"), scope),
    ).not.toContain("<skill>");
    expect(await f.hooks.instructions!(f.ctx, scope)).toBe(initial);
    f.machine.write(
        "/workspace/.agents/skills/aaa-override/SKILL.md",
        "---\nname: skill-000\ndescription: New higher-precedence installation.\n---\nReplacement.",
    );
    await f.hooks.beforeTurn!(f.ctx, scope, {} as never);
    await f.module.slashCommands(f.ctx, scope.agent.id);
    directoryRead.mockClear();
    const next = await f.hooks.instructions!(f.ctx, scope);
    expect(next).not.toContain("<name>skill-000</name>");
    expect(directoryRead).not.toHaveBeenCalled();
});

it("says nothing about skills on every inference of a turn when nothing is shortlisted", async () => {
    const db = moduleDatabase([], "skill-shortlist-empty");
    ensureAgentDatabaseConnection(db.database);
    await db.ready;
    cleanups.push(db.close);
    const machine = new FakeCompute("/workspace");
    machine.directories.add("/workspace/.git");
    const hooks = await resolveModuleHooks(
        db.context,
        new SkillsModule(scriptedComputeModule(async () => machine)),
    );
    const store = new InMemoryPersistence();
    const scope: AgentModuleScope = {
        agent: { id: "bare" } as never,
        kv: new AgentKV(store, "bare.agent."),
        runKV: new AgentKV(store, "bare.run."),
        historyKV: new AgentKV(store, "bare.history."),
        sharedKV: new AgentKV(store, "shared."),
    };
    await hooks.messageAcceptedTransact!(db.context, scope, {
        id: "message",
        kind: "send",
        profile: null,
        message: { role: "user", content: [{ type: "text", text: "Hello." }] },
        metadata: { messageOrigin: "user", userId: "alice" },
    });
    await hooks.beforeTurn!(db.context, scope, undefined as never);
    // The first inference of a turn asks full discovery; the later ones revalidate the stored
    // shortlist. Both must give the provider the same system prompt.
    expect(await hooks.instructions!(db.context, scope)).toBe("");
    expect(await hooks.instructions!(db.context, scope)).toBe("");
    expect(await hooks.instructions!(db.context, scope)).toBe("");
});
