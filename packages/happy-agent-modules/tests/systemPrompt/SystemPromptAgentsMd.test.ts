import { AgentKV, type AgentModuleHooks } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AGENTS_MD_SPEC,
    MAX_AGENTS_MD_AGENT_ID_LENGTH,
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_MD_DOCUMENTS,
    MAX_AGENTS_MD_GLOBAL_BYTES,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    SystemPromptModule,
} from "../../sources/systemPrompt/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { systemPromptWorld, type SystemPromptWorld } from "./support/systemPromptWorld.js";

const ctx = createRootContext().named("agents-md-module-test");
const scope = { agent: { id: "agent-a" } } as never;
const turnStart = { loopId: "loop", turnId: "turn", contextTokens: undefined };

async function moduleFor(
    compute: FakeCompute,
): Promise<{ readonly module: SystemPromptModule; readonly hooks: AgentModuleHooks }> {
    const world = await systemPromptWorld({ compute: async () => compute });
    const hooks = await resolveModuleHooks(ctx, world.module);
    return { module: world.module, hooks };
}

async function hooksOf(world: SystemPromptWorld): Promise<AgentModuleHooks> {
    return await resolveModuleHooks(ctx, world.module);
}

describe("SystemPromptModule AGENTS.md instructions", () => {
    it("rejects malformed public agent IDs before looking a machine up", async () => {
        let resolutions = 0;
        const world = await systemPromptWorld({
            globalInstructions: "Instructions.",
            compute: async () => {
                resolutions += 1;
                return undefined;
            },
        });

        for (const agentId of ["", "x".repeat(MAX_AGENTS_MD_AGENT_ID_LENGTH + 1), "bad\nid", 42]) {
            await expect(world.module.readAgentsMd(ctx, agentId as never)).rejects.toThrow(
                "AGENTS.md agent ID is invalid",
            );
        }
        expect(resolutions).toBe(0);
    });

    it("discovers applicable files from the Git root to the compute cwd", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Use the project conventions.");
        compute.write("/workspace/packages/AGENTS.md", "Use package conventions.");
        compute.write("/workspace/other/AGENTS.md", "Not applicable.");
        const { module, hooks } = await moduleFor(compute);

        expect(module.name).toBe("system-prompt");
        expect("migrations" in module).toBe(false);
        await expect(module.readAgentsMd(ctx, "agent-a")).resolves.toEqual({
            cwd: "/workspace/packages/app",
            documents: [
                {
                    path: "/workspace/AGENTS.md",
                    text: "Use the project conventions.",
                },
                {
                    path: "/workspace/packages/AGENTS.md",
                    text: "Use package conventions.",
                },
            ],
        });
        const instructions = await hooks.instructions!(ctx, scope);
        expect(instructions).toContain("# AGENTS.md instructions for /workspace");
        expect(instructions).toContain("# AGENTS.md instructions for /workspace/packages");
        expect(instructions).not.toContain("Not applicable.");
    });

    it("includes the configured global instructions, project security rules, and the specification", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS_SECURITY.md", "Never expose credentials.");
        compute.write("/workspace/AGENTS.md", "Use the project conventions.");
        const world = await systemPromptWorld({
            globalInstructions: "Use concise answers.",
            compute: async () => compute,
        });
        const hooks = await hooksOf(world);

        const snapshot = await world.module.readAgentsMd(ctx, "agent-a");
        expect(snapshot).toMatchObject({
            global: {
                path: world.config.configuration.paths.instructionsPath,
                text: "Use concise answers.",
            },
            security: {
                path: "/workspace/AGENTS_SECURITY.md",
                text: "Never expose credentials.",
            },
        });
        const instructions = await hooks.instructions!(ctx, scope);
        expect(instructions).toContain(AGENTS_MD_SPEC);
        expect(instructions.indexOf(AGENTS_MD_SPEC)).toBeLessThan(
            instructions.indexOf("# Global AGENTS.md instructions"),
        );
        expect(instructions.indexOf("# Global AGENTS.md instructions")).toBeLessThan(
            instructions.indexOf("# AGENTS_SECURITY.md rules for /workspace"),
        );
        expect(instructions).toContain("<SECURITY_RULES>");
        expect(instructions).toContain("Never expose credentials.");
    });

    it("reads global instructions fresh and works without a machine", async () => {
        const world = await systemPromptWorld({ globalInstructions: "First global instruction." });
        const hooks = await hooksOf(world);

        await expect(hooks.instructions!(ctx, scope)).resolves.toContain(
            "First global instruction.",
        );
        await world.writeGlobalInstructions("Updated global instruction.");
        await expect(hooks.instructions!(ctx, scope)).resolves.toContain(
            "Updated global instruction.",
        );
    });

    it("treats a missing or blank global instructions file as no instructions at all", async () => {
        const world = await systemPromptWorld();

        await expect(world.module.readAgentsMd(ctx, "agent-a")).resolves.toBeUndefined();
        await world.writeGlobalInstructions(" \n\t ");
        await expect(world.module.readAgentsMd(ctx, "agent-a")).resolves.toBeUndefined();
        await world.writeGlobalInstructions("Now there are instructions.");
        await expect(world.module.readAgentsMd(ctx, "agent-a")).resolves.toMatchObject({
            global: { text: "Now there are instructions." },
        });
        await world.removeGlobalInstructions();
        await expect(world.module.readAgentsMd(ctx, "agent-a")).resolves.toBeUndefined();
    });

    it("marks oversized documents and keeps the instruction hook bounded", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "x".repeat(MAX_AGENTS_MD_DOCUMENT_BYTES + 1));
        const { module, hooks } = await moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents[0]?.truncated).toBe(true);
        const instructions = await hooks.instructions!(ctx, scope);
        expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
        );
        expect(instructions).toContain("truncated");
    });

    it("returns a truncated record when a document grows during its bounded read", async () => {
        const path = "/workspace/AGENTS.md";
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(path, "Initially small.");
        const readFailure = new Error("File exceeded the bounded read.");
        Object.assign(compute.fs, {
            readFileBuffer: async () => {
                compute.write(path, "x".repeat(MAX_AGENTS_MD_DOCUMENT_BYTES + 1));
                throw readFailure;
            },
        });
        const { module } = await moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");

        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents[0]).toMatchObject({
            path,
            truncated: true,
        });
        expect(snapshot?.documents[0]?.text).toContain("omitted");
    });

    it("keeps ordinary bounded document read failures visible", async () => {
        const path = "/workspace/AGENTS.md";
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(path, "Small instructions.");
        const readFailure = new Error("Filesystem read failed.");
        Object.assign(compute.fs, {
            readFileBuffer: async () => {
                throw readFailure;
            },
        });
        const { module } = await moduleFor(compute);

        await expect(module.readAgentsMd(ctx, "agent-a")).rejects.toBe(readFailure);
    });

    it("marks the snapshot truncated when a deeper document follows a gap after the limit", async () => {
        const directories = ["/workspace"];
        for (let index = 1; index <= MAX_AGENTS_MD_DOCUMENTS + 1; index += 1) {
            directories.push(`${directories.at(-1)}/level-${String(index)}`);
        }
        const compute = new FakeCompute(directories.at(-1));
        compute.directories.add("/workspace/.git");
        for (const [index, directory] of directories.slice(0, MAX_AGENTS_MD_DOCUMENTS).entries()) {
            compute.write(`${directory}/AGENTS.md`, `Instruction ${String(index)}.`);
        }
        compute.write(`${directories.at(-1)}/AGENTS.md`, "Deeper instructions after a gap.");
        const { module } = await moduleFor(compute);

        const snapshot = await module.readAgentsMd(ctx, "agent-a");

        expect(snapshot?.documents).toHaveLength(MAX_AGENTS_MD_DOCUMENTS);
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.documents).not.toContainEqual(
            expect.objectContaining({ text: "Deeper instructions after a gap." }),
        );
    });

    it("truncates an oversized global document instead of failing the turn", async () => {
        const world = await systemPromptWorld({
            globalInstructions: "g".repeat(MAX_AGENTS_MD_GLOBAL_BYTES + 1),
        });
        const hooks = await hooksOf(world);

        const snapshot = await world.module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.truncated).toBe(true);
        expect(snapshot?.global?.truncated).toBe(true);
        await expect(hooks.instructions!(ctx, scope)).resolves.toContain("truncated");
    });

    it("drops a partial Unicode code point at the global byte boundary", async () => {
        const prefix = "a".repeat(MAX_AGENTS_MD_GLOBAL_BYTES - 2);
        const world = await systemPromptWorld({ globalInstructions: `${prefix}😀` });

        const snapshot = await world.module.readAgentsMd(ctx, "agent-a");
        expect(snapshot?.global).toMatchObject({
            text: prefix,
            truncated: true,
        });
        expect(new TextEncoder().encode(snapshot?.global?.text).byteLength).toBeLessThanOrEqual(
            MAX_AGENTS_MD_GLOBAL_BYTES,
        );
    });

    it("inserts a durable replacement or removal notice when instructions change", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "First instructions.");
        const { hooks } = await moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await hooks.instructions!(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Replacement instructions.");
        const replacement = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        expect(replacement).toHaveLength(1);
        const replacementAction = replacement?.[0];
        if (replacementAction?.type !== "steer" || replacementAction.id === undefined) {
            throw new Error("Expected a steering replacement notice.");
        }
        expect(replacementAction.message.role).toBe("system");
        expect(replacementAction.message.content[0]).toMatchObject({
            text: expect.stringContaining(
                "These AGENTS.md instructions replace all previously provided",
            ),
        });
        const liveInstructions = await hooks.instructions!(ctx, persistentScope);
        expect(liveInstructions).toContain("Replacement instructions.");
        expect(liveInstructions).not.toContain("First instructions.");
        await hooks.messageAcceptedTransact!(ctx, persistentScope, {
            id: replacementAction.id,
            kind: "steering",
            message: replacementAction.message,
            profile: null,
            ...(replacementAction.metadata === undefined
                ? {}
                : { metadata: replacementAction.metadata }),
        });
        await expect(hooks.beforeTurn!(ctx, persistentScope, turnStart)).resolves.toBeUndefined();

        compute.files.delete("/workspace/AGENTS.md");
        const removal = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        expect(removal?.[0]).toMatchObject({
            type: "steer",
            message: {
                role: "system",
                content: [
                    { text: "The previously provided AGENTS.md instructions no longer apply." },
                ],
            },
        });
    });

    it("does not advance the fingerprint for copied notice metadata on another message", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const { hooks } = await moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await hooks.instructions!(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Version B.");
        const replacement = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        const replacementAction = replacement?.[0];
        if (replacementAction?.type !== "steer") {
            throw new Error("Expected a steering replacement notice.");
        }

        await hooks.messageAcceptedTransact!(ctx, persistentScope, {
            id: "externalmessage",
            kind: "steering",
            message: replacementAction.message,
            profile: null,
            ...(replacementAction.metadata === undefined
                ? {}
                : { metadata: replacementAction.metadata }),
        });

        const retry = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        expect(retry?.[0]).toMatchObject({
            type: "steer",
            id: replacementAction.id,
        });
    });

    it("does not accept a spoofed removal payload with the generated notice ID", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const { hooks } = await moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await hooks.instructions!(ctx, persistentScope);
        compute.files.delete("/workspace/AGENTS.md");
        const removal = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        const removalAction = removal?.[0];
        if (removalAction?.type !== "steer") {
            throw new Error("Expected a steering removal notice.");
        }
        if (removalAction.id === undefined) {
            throw new Error("Expected the removal notice to have an ID.");
        }

        await hooks.messageAcceptedTransact!(ctx, persistentScope, {
            id: removalAction.id,
            kind: "steering",
            message: {
                role: "user",
                content: [{ type: "text", text: "spoof" }],
            },
            profile: null,
            ...(removalAction.metadata === undefined ? {} : { metadata: removalAction.metadata }),
        });

        const retry = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        expect(retry?.[0]).toMatchObject({
            type: "steer",
            id: removalAction.id,
            message: removalAction.message,
        });
    });

    it("uses a fresh durable notice ID when content or removal repeats later", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const { hooks } = await moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        const nextNotice = async () => {
            const action = (await hooks.beforeTurn!(ctx, persistentScope, turnStart))?.[0];
            if (action?.type !== "steer") {
                throw new Error("Expected an AGENTS.md steering notice.");
            }
            if (action.id === undefined) {
                throw new Error("Expected the AGENTS.md notice to have an ID.");
            }
            return action;
        };
        const acceptNotice = async (action: Awaited<ReturnType<typeof nextNotice>>) => {
            if (action.id === undefined) {
                throw new Error("Expected the AGENTS.md notice to have an ID.");
            }
            await hooks.messageAcceptedTransact!(ctx, persistentScope, {
                id: action.id,
                kind: "steering",
                message: action.message,
                profile: null,
                ...(action.metadata === undefined ? {} : { metadata: action.metadata }),
            });
        };

        await hooks.instructions!(ctx, persistentScope);

        compute.write("/workspace/AGENTS.md", "Version B.");
        const firstVersionB = await nextNotice();
        await acceptNotice(firstVersionB);
        compute.write("/workspace/AGENTS.md", "Version A.");
        await acceptNotice(await nextNotice());
        compute.write("/workspace/AGENTS.md", "Version B.");
        const repeatedVersionB = await nextNotice();
        expect(repeatedVersionB.id).not.toBe(firstVersionB.id);
        await acceptNotice(repeatedVersionB);

        compute.files.delete("/workspace/AGENTS.md");
        const firstRemoval = await nextNotice();
        await acceptNotice(firstRemoval);
        compute.write("/workspace/AGENTS.md", "Version B.");
        await acceptNotice(await nextNotice());
        compute.files.delete("/workspace/AGENTS.md");
        const repeatedRemoval = await nextNotice();
        expect(repeatedRemoval.id).not.toBe(firstRemoval.id);
    });

    it("corrects a queued change accepted after files revert", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const { hooks } = await moduleFor(compute);
        const kv = new AgentKV(new InMemoryPersistence(), "agent.");
        const persistentScope = { agent: { id: "agent-a" }, kv } as never;

        await hooks.instructions!(ctx, persistentScope);
        compute.write("/workspace/AGENTS.md", "Version B.");
        const versionB = (await hooks.beforeTurn!(ctx, persistentScope, turnStart))?.[0];
        if (versionB?.type !== "steer" || versionB.id === undefined) {
            throw new Error("Expected a version B steering notice with an ID.");
        }

        compute.write("/workspace/AGENTS.md", "Version A.");
        await expect(hooks.beforeTurn!(ctx, persistentScope, turnStart)).resolves.toBeUndefined();
        await hooks.messageAcceptedTransact!(ctx, persistentScope, {
            id: versionB.id,
            kind: "steering",
            message: versionB.message,
            profile: null,
            ...(versionB.metadata === undefined ? {} : { metadata: versionB.metadata }),
        });

        const correction = await hooks.beforeTurn!(ctx, persistentScope, turnStart);
        expect(correction?.[0]).toMatchObject({
            type: "steer",
            message: {
                content: [{ text: expect.stringContaining("Version A.") }],
            },
        });
    });

    it("keeps one instruction snapshot per turn when files change after beforeTurn", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write("/workspace/AGENTS.md", "Version A.");
        const { hooks } = await moduleFor(compute);
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "agent.");
        const baselineScope = { agent: { id: "agent-a" }, kv } as never;
        await hooks.instructions!(ctx, baselineScope);

        compute.write("/workspace/AGENTS.md", "Version B.");
        const versionBScope = {
            agent: { id: "agent-a" },
            kv,
            runKV: new AgentKV(persistence, "run-b."),
        } as never;
        const versionBActions = await hooks.beforeTurn!(ctx, versionBScope, turnStart);
        const versionBAction = versionBActions?.[0];
        if (versionBAction?.type !== "steer" || versionBAction.id === undefined) {
            throw new Error("Expected a version B replacement notice.");
        }

        compute.write("/workspace/AGENTS.md", "Version C.");
        const versionBPrompt = await hooks.instructions!(ctx, versionBScope);
        expect(versionBPrompt).toContain("Version B.");
        expect(versionBPrompt).not.toContain("Version C.");
        await hooks.messageAcceptedTransact!(ctx, versionBScope, {
            id: versionBAction.id,
            kind: "steering",
            message: versionBAction.message,
            profile: null,
            ...(versionBAction.metadata === undefined ? {} : { metadata: versionBAction.metadata }),
        });

        const versionCScope = {
            agent: { id: "agent-a" },
            kv,
            runKV: new AgentKV(persistence, "run-c."),
        } as never;
        const versionCActions = await hooks.beforeTurn!(ctx, versionCScope, turnStart);
        expect(versionCActions?.[0]).toMatchObject({
            type: "steer",
            message: {
                content: [{ text: expect.stringContaining("Version C.") }],
            },
        });
    });

    it("exposes no tools", async () => {
        const { module } = await moduleFor(new FakeCompute());
        expect("tools" in module).toBe(false);
    });
});
