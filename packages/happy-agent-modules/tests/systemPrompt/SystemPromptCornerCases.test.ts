import { AgentKV, type AgentModuleHooks } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENTS_MD_SPEC,
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_SECURITY_MD_BYTES,
    SystemPromptModule,
    systemPromptSelectionSchema,
    systemPromptForModel,
} from "../../sources/systemPrompt/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { systemPromptWorld } from "./support/systemPromptWorld.js";

const ctx: Context = createRootContext().named("system-prompt-corner-cases");
const turnStart = { loopId: "loop", turnId: "turn", contextTokens: undefined };

/** A module reading the machine a test built, and its resolved hooks. */
async function moduleFor(
    compute: FakeCompute | undefined,
): Promise<{ readonly module: SystemPromptModule; readonly hooks: AgentModuleHooks }> {
    const world = await systemPromptWorld({ compute: async () => compute });
    return { module: world.module, hooks: await resolveModuleHooks(ctx, world.module) };
}

function agentScope(
    agentId = "agent-a",
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return { agent: { id: agentId }, ...extra };
}

describe("SystemPromptModule corner cases", () => {
    it("does not follow an AGENTS.md symbolic link", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.links.set("/workspace/AGENTS.md", "/outside/AGENTS.md");
        const { module } = await moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toThrow(
            "AGENTS.md document must not be a symbolic link",
        );
    });

    it("does not follow a project-root security symbolic link", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.links.set("/workspace/AGENTS_SECURITY.md", "/outside/AGENTS_SECURITY.md");
        const { module } = await moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toThrow(
            "AGENTS.md document must not be a symbolic link",
        );
    });

    it("ignores directories, empty files, and whitespace-only instruction files", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.directories.add("/workspace/AGENTS_SECURITY.md");
        compute.directories.add("/workspace/empty/AGENTS.md");
        compute.write("/workspace/AGENTS.md", " \n\t ");
        compute.write("/workspace/empty/AGENTS.md", "\n");
        const { module } = await moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).resolves.toEqual({
            cwd: "/workspace",
            documents: [],
        });
    });

    it("returns a detached snapshot that callers cannot mutate in place", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Keep this instruction.");
        const { module } = await moduleFor(compute);

        const first = await module.readAgentsMd(ctx, "agent-a");
        if (first === undefined) throw new Error("Expected an AGENTS.md snapshot.");
        first.documents[0]!.text = "Caller mutation.";

        await expect(module.readAgentsMd(ctx, "agent-a")).resolves.toMatchObject({
            documents: [{ text: "Keep this instruction." }],
        });
    });

    it("reads AGENTS.md from an agent's folder on a runner", async () => {
        const compute = new FakeCompute("/srv/projects/demo");
        compute.directories.add("/srv/projects/demo/.git");
        compute.write("/srv/projects/demo/AGENTS.md", "Runner instructions.");
        const runnerMachine = Object.assign(Object.create(compute) as FakeCompute, {
            id: "runner",
        });
        const world = await systemPromptWorld({ compute: async () => runnerMachine });

        await expect(world.module.readAgentsMd(ctx, "agent-a")).resolves.toMatchObject({
            documents: [{ text: "Runner instructions." }],
        });
    });

    it("validates a malformed compute returned at runtime before using its filesystem", async () => {
        const world = await systemPromptWorld({
            compute: async () => ({ invalid: true }) as never,
        });

        await expect(world.module.readAgentsMd(ctx, "agent-a")).rejects.toThrow(
            "The compute module returned an invalid compute",
        );
    });

    it("rejects an invalid file stat instead of treating it as an absent document", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        Object.assign(compute.fs, {
            lstat: async () => ({
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
                size: -1,
                mtimeMs: 1,
            }),
        });
        const { module } = await moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toThrow(
            "Compute returned an invalid file stat",
        );
    });

    it("keeps the public reviewer formatting separate from delivery state", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "agent.");
        const { module, hooks } = await moduleFor(compute);
        const scope = { ...agentScope(), kv } as never;

        await hooks.instructions!(ctx, scope);
        compute.write("/workspace/AGENTS.md", "Version B.");
        const reviewerText = await module.readAgentsMdInstructions(ctx, "agent-a");
        expect(reviewerText).toContain("Version B.");

        const action = (await hooks.beforeTurn!(ctx, scope, turnStart))?.[0];
        expect(action).toMatchObject({
            type: "steer",
            message: {
                content: [{ text: expect.stringContaining("Version B.") }],
            },
        });
    });

    it("does not add the AGENTS specification to the reviewer result when no document exists", async () => {
        const { module } = await moduleFor(undefined);

        await expect(module.readAgentsMdInstructions(ctx, "agent-a")).resolves.toBeUndefined();
    });

    it("rejects a persisted turn snapshot with duplicate document identities", async () => {
        const persistence = new InMemoryPersistence();
        const runKV = new AgentKV(persistence, "run.");
        await runKV.write(ctx, "turn-instructions-snapshot", {
            cwd: "/workspace",
            documents: [
                { path: "/workspace/AGENTS.md", text: "First." },
                { path: "/workspace/AGENTS.md", text: "Duplicate." },
            ],
        });
        const { hooks } = await moduleFor(undefined);

        await expect(
            hooks.instructions!(ctx, {
                ...agentScope(),
                runKV,
            } as never),
        ).rejects.toThrow("Stored AGENTS.md turn snapshot is invalid");
    });

    it("rejects a persisted security document over its stricter security bound", async () => {
        const persistence = new InMemoryPersistence();
        const runKV = new AgentKV(persistence, "run.");
        await runKV.write(ctx, "turn-instructions-snapshot", {
            cwd: "/workspace",
            documents: [],
            security: {
                path: "/workspace/AGENTS_SECURITY.md",
                text: "x".repeat(MAX_AGENTS_SECURITY_MD_BYTES + 1),
            },
        });
        const { hooks } = await moduleFor(undefined);

        await expect(
            hooks.instructions!(ctx, {
                ...agentScope(),
                runKV,
            } as never),
        ).rejects.toThrow("Stored AGENTS.md turn snapshot is invalid");
    });

    it("rejects a persisted document whose UTF-8 bytes exceed the document bound", async () => {
        const persistence = new InMemoryPersistence();
        const runKV = new AgentKV(persistence, "run.");
        const text = "界".repeat(Math.floor(MAX_AGENTS_MD_DOCUMENT_BYTES / 3) + 1);
        expect(text.length).toBeLessThanOrEqual(MAX_AGENTS_MD_DOCUMENT_BYTES);
        expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(
            MAX_AGENTS_MD_DOCUMENT_BYTES,
        );
        await runKV.write(ctx, "turn-instructions-snapshot", {
            cwd: "/workspace",
            documents: [{ path: "/workspace/AGENTS.md", text }],
        });
        const { hooks } = await moduleFor(undefined);

        await expect(
            hooks.instructions!(ctx, {
                ...agentScope(),
                runKV,
            } as never),
        ).rejects.toThrow("Stored AGENTS.md turn snapshot is invalid");
    });

    it("treats an omitted model as valid selection input", () => {
        expect(Value.Check(systemPromptSelectionSchema, { providerKind: "codex" })).toBe(true);
        expect(systemPromptForModel({ providerKind: "codex" } as never)).toBe(
            systemPromptForModel({ model: "openai/gpt-5.6-sol" }),
        );
    });

    it("keeps the AGENTS specification available in the normal prompt with no files", async () => {
        const { hooks } = await moduleFor(undefined);

        await expect(hooks.instructions!(ctx, agentScope() as never)).resolves.toContain(
            AGENTS_MD_SPEC,
        );
    });
});
