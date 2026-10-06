import { Value } from "@sinclair/typebox/value";
import { Agent, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";
import type { AutoModule } from "../../../sources/auto/index.js";
import {
    PermissionsModule,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "../../../sources/permissions/index.js";
import { agentWorld } from "../../support/agentWorld.js";
import { providersOf, sharedKV, textTurn, toolCallTurn, user } from "../../support/fixtures.js";
import { resolveModuleRuntime } from "../../support/moduleHooks.js";
import { ScriptedProvider } from "../../support/ScriptedProvider.js";
import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("kimi-compute-permissions");
const paths = [
    ["Read", { path: "a.txt" }],
    ["Write", { path: "a.txt", content: "hello" }],
    ["Edit", { path: "a.txt", old_string: "hello", new_string: "world" }],
    ["Glob", { pattern: "*.ts", path: "." }],
    ["Grep", { pattern: "hello", path: "." }],
    ["ReadMediaFile", { path: "a.png" }],
] as const;

describe("Kimi tool-owned permissions", () => {
    it.each(paths)(
        "uses the actual %s definition for default, explicit, and canonical path decisions",
        async (name, args) => {
            const compute = new FakeCompute();
            compute.links.set("/workspace/link", "/outside");
            const { tool } = await computeToolset(ctx, compute, { model: "moonshotai/kimi-k3" });
            const definition = tool(name);
            expect(Value.Check(definition.parameters!, args)).toBe(true);
            expect(await definition.shouldReviewInAutoMode(args, ctx)).toBe(false);
            const elevated = {
                ...args,
                sandbox_permissions: "require_escalated",
                justification: "Authorized inspection or change.",
            };
            expect(Value.Check(definition.parameters!, elevated)).toBe(true);
            expect(await definition.shouldReviewInAutoMode(elevated, ctx)).toBe(true);
            expect(await definition.shouldRunInFullAccessInAutoMode?.(elevated, ctx)).toBe(true);
            expect(definition.describeAutoPermissionAction?.(elevated, ctx)).toContain(
                "unrestricted filesystem access",
            );
            for (const path of ["/outside/a.txt", "/workspace/link/a.txt"]) {
                expect(await definition.shouldReviewInAutoMode({ ...args, path }, ctx)).toBe(true);
                expect(
                    await definition.shouldRunInFullAccessInAutoMode?.({ ...args, path }, ctx),
                ).toBe(true);
            }
            if (name === "Write" || name === "Edit") {
                for (const path of [
                    "/workspace/.git/config",
                    "/workspace/happy.toml",
                    "/workspace/AGENTS_SECURITY.md",
                ]) {
                    expect(await definition.shouldReviewInAutoMode({ ...args, path }, ctx)).toBe(
                        true,
                    );
                    expect(
                        await definition.shouldRunInFullAccessInAutoMode?.({ ...args, path }, ctx),
                    ).toBe(true);
                }
            }
        },
    );

    it("reviews shell escalation and secret selection separately", async () => {
        const { tool } = await computeToolset(ctx, new FakeCompute(), {
            model: "moonshotai/kimi-k3",
        });
        const bash = tool("Bash");
        for (const args of [
            { command: "true" },
            { command: "true", sandbox_permissions: "use_default" },
        ]) {
            expect(await bash.shouldReviewInAutoMode(args, ctx)).toBe(false);
            expect(await bash.shouldRunInFullAccessInAutoMode?.(args, ctx)).toBe(false);
        }
        expect(
            await bash.shouldReviewInAutoMode({ command: "true", secrets: ["token"] }, ctx),
        ).toBe(true);
        expect(
            await bash.shouldRunInFullAccessInAutoMode?.(
                { command: "true", secrets: ["token"] },
                ctx,
            ),
        ).toBe(false);
        const elevated = { command: "true", sandbox_permissions: "require_escalated" };
        expect(await bash.shouldReviewInAutoMode(elevated, ctx)).toBe(true);
        expect(await bash.shouldRunInFullAccessInAutoMode?.(elevated, ctx)).toBe(true);
        expect(bash.describeAutoPermissionAction?.(elevated, ctx)).toContain(
            "unrestricted filesystem and network",
        );
        expect(Value.Check(bash.parameters!, { command: "true", timeout: 301 })).toBe(false);
        expect(Value.Check(bash.parameters!, { command: "true", disable_timeout: true })).toBe(
            false,
        );
    });

    it.each(["auto-allow", "auto-deny", "read_only", "workspace_write"] as const)(
        "carries %s through execution and restores the next call's boundary",
        async (mode) => {
            const compute = new FakeCompute();
            const { tool, module } = await computeToolset(ctx, compute, {
                model: "moonshotai/kimi-k3",
            });
            const writes: { path: string; mode: AgentPermissionMode }[] = [];
            const write = compute.fs.writeFile.bind(compute.fs);
            vi.spyOn(compute.fs, "writeFile").mockImplementation(
                async (permissions, path, content) => {
                    writes.push({ path, mode: permissions.mode });
                    if (permissions.mode === "read_only")
                        throw new Error("Read only cannot write files.");
                    await write(permissions, path, content);
                },
            );
            const reviews: PermissionReviewRequest[] = [];
            const reviewer: PermissionReviewer = {
                review: async (_ctx, request) => {
                    reviews.push(request);
                    return {
                        outcome: mode === "auto-deny" ? "denied" : "allowed",
                        risk: "medium",
                        userAuthorization: "high",
                        reason: "Scripted exact-action review.",
                    };
                },
            };
            const permissions = new PermissionsModule(module, {
                reviewer,
            } as unknown as AutoModule);
            const provider = new ScriptedProvider([
                toolCallTurn(
                    "elevated",
                    "Write",
                    JSON.stringify({
                        path: "elevated.txt",
                        content: "first",
                        sandbox_permissions: "require_escalated",
                    }),
                ),
                toolCallTurn(
                    "routine",
                    "Write",
                    JSON.stringify({ path: "routine.txt", content: "second" }),
                ),
                textTurn("done"),
            ]);
            const world = await agentWorld();
            const permissionMode = mode === "auto-allow" || mode === "auto-deny" ? "auto" : mode;
            const agent = await Agent.create(ctx, {
                id: "kimi-permission-agent",
                providers: providersOf(provider),
                provider: "scripted",
                persistence: world.storage.persistence("kimi-permission-agent"),
                sharedKV: sharedKV(),
                modules: [await resolveModuleRuntime(ctx, permissions)],
                initialState: { tools: [tool("Write")] },
                permissionMode,
            });
            try {
                await agent.send(
                    ctx,
                    user(
                        "Write both requested files; I authorize elevation for the first call only.",
                    ),
                );
                await agent.waitForIdle();
                expect(reviews).toHaveLength(permissionMode === "auto" ? 1 : 0);
                const first = writes.filter((entry) => entry.path.endsWith("elevated.txt"));
                expect(first).toEqual(
                    mode === "auto-deny"
                        ? []
                        : [
                              {
                                  path: "/workspace/elevated.txt",
                                  mode: mode === "auto-allow" ? "full_access" : permissionMode,
                              },
                          ],
                );
                expect(writes.at(-1)).toEqual({
                    path: "/workspace/routine.txt",
                    mode: permissionMode,
                });
            } finally {
                await agent.close();
            }
        },
    );
});
