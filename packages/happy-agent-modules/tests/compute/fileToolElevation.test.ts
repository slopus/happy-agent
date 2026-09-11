import { Value } from "@sinclair/typebox/value";
import { Agent, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import type { AutoModule } from "../../sources/auto/index.js";
import {
    PermissionsModule,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "../../sources/permissions/index.js";
import { agentWorld } from "../support/agentWorld.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../support/fixtures.js";
import { resolveModuleRuntime } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("file-tool-elevation");
const cases = [
    {
        model: "openai/gpt-5",
        name: "apply_patch",
        args: { patch: "*** Begin Patch\n*** Add File: output.txt\n+hello\n*** End Patch" },
        escalation: {
            sandbox_permissions: "require_escalated",
            justification: "Explicitly authorized file change.",
        },
        defaults: { sandbox_permissions: "use_default" },
    },
    {
        model: "anthropic/opus-5",
        name: "Write",
        args: { file_path: "/workspace/output.txt", content: "hello" },
        escalation: { dangerouslyDisableSandbox: true },
        defaults: { dangerouslyDisableSandbox: false },
    },
    {
        model: "anthropic/opus-5",
        name: "Edit",
        args: { file_path: "/workspace/output.txt", old_string: "hello", new_string: "world" },
        escalation: { dangerouslyDisableSandbox: true },
        defaults: { dangerouslyDisableSandbox: false },
    },
    {
        model: "xai/grok-4.5",
        name: "write",
        args: { file_path: "/workspace/output.txt", content: "hello" },
        escalation: {
            sandbox_permissions: "require_escalated",
            description: "Explicitly authorized file change.",
        },
        defaults: { sandbox_permissions: "use_default" },
    },
    {
        model: "xai/grok-4.5",
        name: "search_replace",
        args: { file_path: "/workspace/output.txt", old_string: "hello", new_string: "world" },
        escalation: {
            sandbox_permissions: "require_escalated",
            description: "Explicitly authorized file change.",
        },
        defaults: { sandbox_permissions: "use_default" },
    },
] as const;

describe.each(cases)(
    "$name explicit file elevation",
    ({ model, name, args, escalation, defaults }) => {
        it("accepts optional vendor-shaped elevation and reviews even an ordinary workspace path", async () => {
            const { tool } = await computeToolset(ctx, new FakeCompute(), { model });
            const definition = tool(name);
            const elevated = { ...args, ...escalation };
            expect(Value.Check(definition.parameters!, elevated)).toBe(true);
            expect(await definition.shouldReviewInAutoMode(elevated, ctx)).toBe(true);
            expect(await definition.shouldRunInFullAccessInAutoMode?.(elevated, ctx)).toBe(true);
            expect(definition.describeAutoPermissionAction?.(elevated, ctx)).toContain(
                "unrestricted filesystem access",
            );
            expect(definition.autoPermissionInstructions).toContain("review");
            for (const ordinary of [args, { ...args, ...defaults }]) {
                expect(Value.Check(definition.parameters!, ordinary)).toBe(true);
                expect(await definition.shouldReviewInAutoMode(ordinary, ctx)).toBe(false);
                expect(await definition.shouldRunInFullAccessInAutoMode?.(ordinary, ctx)).toBe(
                    false,
                );
            }
        });

        it.each([
            "/outside/output.txt",
            "/workspace/.git/config",
            "/workspace/happy.toml",
            "/workspace/link/output.txt",
        ])("still automatically reviews %s without an explicit request", async (path) => {
            const compute = new FakeCompute();
            compute.links.set("/workspace/link", "/outside");
            const { tool } = await computeToolset(ctx, compute, { model });
            const definition = tool(name);
            const input =
                name === "apply_patch"
                    ? {
                          patch: `*** Begin Patch\n*** Add File: ${path}\n+hello\n*** End Patch`,
                          ...defaults,
                      }
                    : { ...args, file_path: path, ...defaults };
            expect(await definition.shouldReviewInAutoMode(input, ctx)).toBe(true);
            expect(await definition.shouldRunInFullAccessInAutoMode?.(input, ctx)).toBe(true);
        });

        it.each([
            "auto-allow",
            "auto-deny",
            "read_only",
            "workspace_write",
            "full_access",
        ] as const)(
            "carries the %s decision through the real agent loop without leaking elevation",
            async (mode) => {
                const compute = new FakeCompute();
                if (name === "Edit" || name === "search_replace")
                    compute.write("/workspace/output.txt", "hello");
                compute.write("/workspace/routine.txt", "hello");
                const { tool, module } = await computeToolset(ctx, compute, { model });
                const writes: { path: string; mode: AgentPermissionMode }[] = [];
                const writeFile = compute.fs.writeFile.bind(compute.fs);
                vi.spyOn(compute.fs, "writeFile").mockImplementation(
                    async (permissions, path, content) => {
                        writes.push({ path, mode: permissions.mode });
                        // This fixture observes the boundary passed to compute; native enforcement is in the gym.
                        if (permissions.mode === "read_only")
                            throw new Error("Read only mode cannot write files.");
                        await writeFile(permissions, path, content);
                    },
                );
                const reviews: PermissionReviewRequest[] = [];
                const reviewer: PermissionReviewer = {
                    review: async (_reviewCtx, request) => {
                        reviews.push(request);
                        return {
                            outcome: mode === "auto-deny" ? "denied" : "allowed",
                            risk: "medium",
                            userAuthorization: "high",
                            reason: "Scripted file review.",
                        };
                    },
                };
                const permissions = new PermissionsModule(module, {
                    reviewer,
                } as unknown as AutoModule);
                const routine =
                    name === "apply_patch"
                        ? {
                              patch: "*** Begin Patch\n*** Add File: next.txt\n+ordinary\n*** End Patch",
                          }
                        : { ...args, file_path: "/workspace/routine.txt" };
                const provider = new ScriptedProvider([
                    toolCallTurn("elevated", name, JSON.stringify({ ...args, ...escalation })),
                    toolCallTurn("ordinary", name, JSON.stringify(routine)),
                    textTurn("done"),
                ]);
                const world = await agentWorld();
                const permissionMode =
                    mode === "auto-allow" || mode === "auto-deny" ? "auto" : mode;
                const agent = await Agent.create(ctx, {
                    id: "file-elevation-agent",
                    providers: providersOf(provider),
                    provider: "scripted",
                    persistence: world.storage.persistence("file-elevation-agent"),
                    sharedKV: sharedKV(),
                    modules: [await resolveModuleRuntime(ctx, permissions)],
                    initialState: { tools: [tool(name)] },
                    permissionMode,
                });
                try {
                    await agent.send(
                        ctx,
                        user(
                            "Make the requested file changes; I authorize elevation for the first change only.",
                        ),
                    );
                    await agent.waitForIdle();
                    expect(reviews).toHaveLength(permissionMode === "auto" ? 1 : 0);
                    if (reviews.length > 0)
                        expect(reviews[0]).toMatchObject({
                            elevates: true,
                            arguments: { ...args, ...escalation },
                        });
                    const first = writes.filter((write) => write.path === "/workspace/output.txt");
                    if (mode === "auto-deny") expect(first).toEqual([]);
                    else
                        expect(first).toEqual([
                            {
                                path: "/workspace/output.txt",
                                mode: mode === "auto-allow" ? "full_access" : permissionMode,
                            },
                        ]);
                    expect(writes.at(-1)).toEqual({
                        path:
                            name === "apply_patch"
                                ? "/workspace/next.txt"
                                : "/workspace/routine.txt",
                        mode: permissionMode,
                    });
                } finally {
                    await agent.close();
                }
            },
        );
    },
);
