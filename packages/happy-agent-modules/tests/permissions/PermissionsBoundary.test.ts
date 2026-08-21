import {
    AgentSystemLocal,
    defineAgentTool,
    type AgentBasePermissionModeChange,
    type AgentBaseToolCall,
    type AgentModuleScope,
    type AgentPermissionMode,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutoModule } from "../../sources/auto/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import {
    MAX_PERMISSION_ACTION,
    MAX_PERMISSION_ARGUMENT_BYTES,
    MAX_PERMISSION_ARGUMENT_DEPTH,
    MAX_PERMISSION_ARGUMENT_ITEMS,
    MAX_PERMISSION_ARGUMENT_STRING,
    MAX_PERMISSION_GUIDANCE_CHARACTERS,
    PERMISSION_ANNOUNCE_TIMEOUT_MS,
    PERMISSION_REFUSALS_BEFORE_STOPPING,
    PERMISSION_REVIEW_TIMEOUT_MS,
    PermissionsModule,
    mergePermissionToolGuidances,
    permissionEventSchema,
    permissionModeChangeNotice,
    permissionModeGuidance,
    permissionReviewDecisionSchema,
    permissionReviewRequestSchema,
    permissionTurnStoppedReason,
    shouldAllowAutoPermissionReview,
    type PermissionEvent,
    type PermissionEventListener,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
    type PermissionReviewer,
    type PermissionToolGuidanceProvider,
} from "../../sources/permissions/index.js";
import { permissionReviewArgumentsSchema as reviewArgumentsSchema } from "../../sources/permissions/PermissionReviewer.js";
import { snapshotPermissionArguments } from "../../sources/permissions/impl/snapshotPermissionArguments.js";
import { autoPermissionPolicyDenialReason } from "../../sources/permissions/impl/shouldAllowAutoPermissionReview.js";
import { PermissionRefusalCircuitBreaker } from "../../sources/permissions/impl/permissionRefusalCircuitBreaker.js";
import { agentWorld } from "../support/agentWorld.js";
import { ScriptedCommandsComputeModule } from "../support/computeModule.js";
import { providersOf, textTurn } from "../support/fixtures.js";
import { resolveModuleRuntime } from "../support/moduleHooks.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-modules-permissions-boundary");

afterEach(() => {
    vi.useRealTimers();
});

const emptyResult = Type.Object({}, { additionalProperties: false });

function testTool(
    name: string,
    options: {
        readonly namespace?: string;
        readonly requiresAutoOrFullAccess?: boolean;
        readonly shouldReviewInAutoMode?: (
            args: unknown,
            toolCtx: Context,
        ) => boolean | Promise<boolean>;
        readonly shouldRunInFullAccessInAutoMode?: (
            args: unknown,
            toolCtx: Context,
        ) => boolean | Promise<boolean>;
        readonly describeAutoPermissionAction?: (args: unknown, toolCtx: Context) => string;
    } = {},
): AnyAgentTool {
    return defineAgentTool({
        name,
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        returnType: emptyResult,
        shouldReviewInAutoMode: options.shouldReviewInAutoMode ?? (() => false),
        ...(options.requiresAutoOrFullAccess === undefined
            ? {}
            : { requiresAutoOrFullAccess: options.requiresAutoOrFullAccess }),
        ...(options.shouldRunInFullAccessInAutoMode === undefined
            ? {}
            : { shouldRunInFullAccessInAutoMode: options.shouldRunInFullAccessInAutoMode }),
        ...(options.describeAutoPermissionAction === undefined
            ? {}
            : { describeAutoPermissionAction: options.describeAutoPermissionAction }),
        execute: async () => ({}),
        toLLM: () => [{ type: "text", text: "ok" }],
    });
}

function scope(agentId: string, permissionMode: AgentPermissionMode): AgentModuleScope {
    return {
        agent: {
            id: agentId,
            metadata: undefined,
            provider: "scripted",
            providerKind: undefined,
            model: undefined,
            effort: undefined,
            tier: undefined,
            permissionMode,
        },
    } as unknown as AgentModuleScope;
}

function call(
    tool: AnyAgentTool,
    argumentsValue: unknown = {},
    callId = "call-1",
): AgentBaseToolCall {
    return { callId, tool, arguments: argumentsValue };
}

function reviewerAnswering(
    decide: (request: PermissionReviewRequest) => PermissionReviewDecision,
): PermissionReviewer & { readonly seen: PermissionReviewRequest[] } {
    const seen: PermissionReviewRequest[] = [];
    return {
        seen,
        review: (_reviewCtx, request) => {
            seen.push(request);
            return Promise.resolve(decide(request));
        },
    };
}

/**
 * The automatic reviewer, as the one member `PermissionsModule` reads of it.
 *
 * The module holds an `AutoModule` and reads `reviewer` off it at the moment of each review, so a
 * test about the permission boundary supplies exactly that member instead of standing up a private
 * review system with its own database, lock, and provider registry. `AutoModule`'s own behavior,
 * including that the reviewer it publishes really is its review system, is proven in `tests/auto`;
 * that the two classes fit together is proven once, against the real class, in
 * `PermissionsModule.test.ts`.
 */
function autoWith(reviewer: PermissionReviewer): AutoModule {
    return { reviewer } as unknown as AutoModule;
}

/** How one test composes the module: the machine, the reviewer, and who is told. */
interface PermissionsSetup {
    readonly compute?: ComputeModule;
    readonly reviewer?: PermissionReviewer;
    readonly onEvent?: PermissionEventListener;
    readonly onEventTransactional?: PermissionEventListener;
    readonly toolGuidance?: readonly PermissionToolGuidanceProvider[];
}

async function resolvedHooks(setup: PermissionsSetup = {}) {
    const compute = setup.compute ?? new ScriptedCommandsComputeModule();
    const permissions =
        setup.reviewer === undefined
            ? new PermissionsModule(compute)
            : new PermissionsModule(compute, autoWith(setup.reviewer));
    if (setup.onEvent !== undefined) permissions.onEvent(setup.onEvent);
    if (setup.onEventTransactional !== undefined) {
        permissions.onEventTransactional(setup.onEventTransactional);
    }
    for (const provider of setup.toolGuidance ?? []) permissions.provideToolGuidance(provider);
    const hooks = await resolveModuleRuntime(ctx, permissions).then((runtime) => runtime.hooks);
    return { compute, permissions, hooks };
}

function deniedDecision(reason = "not allowed"): PermissionReviewDecision {
    return {
        outcome: "denied",
        reason,
        risk: "high",
        userAuthorization: "low",
    };
}

function allowedDecision(
    overrides: Partial<Extract<PermissionReviewDecision, { outcome: "allowed" }>> = {},
): PermissionReviewDecision {
    return {
        outcome: "allowed",
        risk: "low",
        userAuthorization: "high",
        ...overrides,
    };
}

describe("permissions boundary contracts", () => {
    it("holds its bounds as module constants rather than as tunable construction arguments", () => {
        // The three bounds a host used to be able to set are the product's own decisions now, so
        // what a test can assert about them is what they are, and that they are the values Happy Agent v1
        // enforced.
        expect(PERMISSION_REVIEW_TIMEOUT_MS).toBe(90_000);
        expect(PERMISSION_REFUSALS_BEFORE_STOPPING).toBe(3);
        expect(PERMISSION_ANNOUNCE_TIMEOUT_MS).toBe(5_000);
    });

    it("subscribes and unsubscribes each observer independently", async () => {
        const first: PermissionEvent[] = [];
        const second: PermissionEvent[] = [];
        const permissions = new PermissionsModule(new ScriptedCommandsComputeModule());
        const stopFirst = permissions.onEvent((_eventCtx, event) => {
            first.push(event);
        });
        permissions.onEvent((_eventCtx, event) => {
            second.push(event);
        });
        const hooks = await resolveModuleRuntime(ctx, permissions).then((runtime) => runtime.hooks);
        const change = { previousMode: "auto", mode: "read_only" } as const;

        await hooks.permissionModeChanged?.(ctx, scope("subscriber-agent", "read_only"), change);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);

        stopFirst();
        // Ending a subscription twice is not an error, and does not end anyone else's.
        stopFirst();
        await hooks.permissionModeChanged?.(ctx, scope("subscriber-agent", "read_only"), change);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(2);
    });

    it("refuses a tool guidance source that is not a function", () => {
        const permissions = new PermissionsModule(new ScriptedCommandsComputeModule());

        expect(() => permissions.provideToolGuidance([] as never)).toThrow(
            "A permission tool guidance provider must be a function.",
        );
        expect(() => permissions.provideToolGuidance(undefined as never)).toThrow();
    });

    it("validates review requests, verdicts, events, and their string/collection bounds", () => {
        const signal = new AbortController().signal;
        const tool = { name: "publish" };
        const request = {
            agentId: "agent",
            callId: "call",
            tool,
            arguments: { path: "file" },
            action: "Publish file.",
            mode: "auto",
            elevates: true,
            signal,
        };
        expect(Value.Check(permissionReviewRequestSchema, request)).toBe(true);
        expect(
            Value.Check(permissionReviewRequestSchema, {
                ...request,
                action: "x".repeat(MAX_PERMISSION_ACTION + 1),
            }),
        ).toBe(false);
        expect(Value.Check(permissionReviewDecisionSchema, allowedDecision())).toBe(true);
        expect(
            Value.Check(permissionReviewDecisionSchema, {
                outcome: "allowed",
                risk: "low",
                userAuthorization: "high",
                extra: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(permissionEventSchema, {
                type: "permission_action_unproven",
                agentId: "agent",
                callId: "call",
                tool: "publish",
                action: "Publish.",
                kind: "unavailable",
                reason: "x".repeat(4_096),
            }),
        ).toBe(true);
        expect(
            Value.Check(permissionEventSchema, {
                type: "permission_action_unproven",
                agentId: "agent",
                callId: "call",
                tool: "publish",
                action: "Publish.",
                kind: "unavailable",
                reason: "x".repeat(4_097),
            }),
        ).toBe(false);
    });

    it("applies the independent risk and user-authorization policy to every allowed verdict", () => {
        expect(shouldAllowAutoPermissionReview(allowedDecision({ risk: "low" }))).toBe(true);
        expect(
            shouldAllowAutoPermissionReview(
                allowedDecision({ risk: "medium", userAuthorization: "unknown" }),
            ),
        ).toBe(true);
        expect(
            shouldAllowAutoPermissionReview(
                allowedDecision({ risk: "high", userAuthorization: "medium" }),
            ),
        ).toBe(true);
        expect(
            shouldAllowAutoPermissionReview(
                allowedDecision({ risk: "high", userAuthorization: "low" }),
            ),
        ).toBe(false);
        expect(
            shouldAllowAutoPermissionReview(
                allowedDecision({ risk: "high", userAuthorization: "unknown" }),
            ),
        ).toBe(false);
        expect(
            shouldAllowAutoPermissionReview(
                allowedDecision({ risk: "critical", userAuthorization: "high" }),
            ),
        ).toBe(false);
        expect(autoPermissionPolicyDenialReason(allowedDecision({ risk: "critical" }))).toContain(
            "does not allow critical-risk actions",
        );
        expect(
            autoPermissionPolicyDenialReason(
                allowedDecision({ risk: "high", userAuthorization: "low" }),
            ),
        ).toContain("at least medium user authorization");
        expect(autoPermissionPolicyDenialReason(deniedDecision("host denial"))).toBe("host denial");
    });

    it("keeps all four mode guidance surfaces honest and bounds generated instructions", () => {
        const readOnly = permissionModeGuidance("read_only");
        const workspaceWrite = permissionModeGuidance("workspace_write");
        const auto = permissionModeGuidance("auto");
        const fullAccess = permissionModeGuidance("full_access");

        expect(readOnly).toContain("Read only mode");
        expect(readOnly).toContain("Nothing on the host is writable");
        expect(workspaceWrite).toContain("Workspace write mode");
        expect(workspaceWrite).toContain("Writes are confined to the working directory");
        expect(workspaceWrite).toContain("Git control paths are read-only");
        expect(auto).toContain("Auto mode");
        expect(auto).toContain("reviewed automatically");
        expect(fullAccess).toContain("Full access mode");
        expect(fullAccess).not.toContain("Shell commands run in a sandbox");

        const bounded = permissionModeGuidance(
            "auto",
            Array.from({ length: 5 }, (_, index) => ({
                autoPermissionInstructions: `${"x".repeat(8_190)}-${index}`,
            })),
        );
        expect(bounded.length).toBeLessThanOrEqual(MAX_PERMISSION_GUIDANCE_CHARACTERS);
        expect(bounded).toContain("[Additional permission guidance omitted.]");
        expect(permissionModeChangeNotice("read_only")).toContain(
            "The permission mode has been changed to Read only.",
        );
    });

    it("merges every registered guidance source with a bounded, stable first-seen order", async () => {
        const providerCalls: string[] = [];
        const { hooks } = await resolvedHooks({
            toolGuidance: [
                () => [{ autoPermissionInstructions: "static" }],
                async (_providerCtx, agentId) => {
                    providerCalls.push(agentId);
                    return [
                        { autoPermissionInstructions: "static" },
                        { autoPermissionInstructions: "dynamic" },
                    ];
                },
            ],
        });

        const instructions = await hooks.instructions?.(ctx, scope("guidance-agent", "auto"));
        expect(providerCalls).toEqual(["guidance-agent"]);
        expect(instructions).toContain("static");
        expect(instructions).toContain("dynamic");
        expect(instructions?.match(/static/gu)).toHaveLength(1);

        const malformed = await resolvedHooks({
            toolGuidance: [() => [{ invalid: true }] as never],
        });
        await expect(
            malformed.hooks.instructions?.(ctx, scope("malformed-guidance-agent", "auto")),
        ).rejects.toThrow();

        expect(() =>
            mergePermissionToolGuidances([
                Array.from({ length: MAX_PERMISSION_ARGUMENT_ITEMS + 1 }, () => ({
                    autoPermissionInstructions: "too many",
                })),
            ]),
        ).toThrow();
    });

    it("never reviews or elevates calls outside Auto mode", async () => {
        const seen: PermissionReviewRequest[] = [];
        const ranModes: AgentPermissionMode[] = [];
        const reviewer: PermissionReviewer = {
            review: (_reviewCtx, request) => {
                seen.push(request);
                return Promise.resolve(allowedDecision());
            },
        };
        const { hooks } = await resolvedHooks({ reviewer });
        const reviewTool = testTool("review", {
            shouldReviewInAutoMode: () => {
                throw new Error("must not inspect this predicate outside auto");
            },
            describeAutoPermissionAction: () => "Review this action.",
            shouldRunInFullAccessInAutoMode: () => true,
        });

        for (const mode of ["read_only", "workspace_write", "full_access"] as const) {
            const decision = await hooks.beforeToolCall?.(
                ctx,
                scope(`mode-${mode}`, mode),
                call(reviewTool),
            );
            expect(decision).toBeUndefined();
            ranModes.push(mode);
        }
        expect(ranModes).toEqual(["read_only", "workspace_write", "full_access"]);
        expect(seen).toEqual([]);
    });

    it("refuses non-containable tools in both restricted modes without spending the circuit", async () => {
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => allowedDecision());
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const external = testTool("server", {
            namespace: "mcp",
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Call the external server.",
        });

        for (const mode of ["read_only", "workspace_write"] as const) {
            const decision = await hooks.beforeToolCall?.(
                ctx,
                scope(`restricted-${mode}`, mode),
                call(external, {}, `call-${mode}`),
            );
            expect(decision?.type).toBe("answer");
            expect(JSON.stringify(decision)).toContain(`mcp/server`);
        }
        expect(reviewer.seen).toEqual([]);
        expect(events).toEqual([
            expect.objectContaining({
                type: "permission_action_out_of_mode",
                tool: "mcp/server",
                mode: "read_only",
            }),
            expect.objectContaining({
                type: "permission_action_out_of_mode",
                tool: "mcp/server",
                mode: "workspace_write",
            }),
        ]);
    });

    it("allows a reviewed action without elevation and reports that it stayed sandboxed", async () => {
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => allowedDecision({ risk: "medium" }));
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const reviewTool = testTool("inside", {
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => false,
            describeAutoPermissionAction: () => "Run inside the workspace.",
        });

        const decision = await hooks.beforeToolCall?.(
            ctx,
            scope("non-elevating-agent", "auto"),
            call(reviewTool),
        );
        expect(decision).toBeUndefined();
        expect(events).toEqual([
            {
                type: "permission_action_reviewed",
                agentId: "non-elevating-agent",
                callId: "call-1",
                tool: "inside",
                action: "Run inside the workspace.",
                elevated: false,
                reason: "The reviewer allowed this action.",
                risk: "medium",
                userAuthorization: "high",
            },
        ]);
    });

    it("fails closed when either tool predicate or action description is malformed", async () => {
        const seen: PermissionReviewRequest[] = [];
        const reviewer: PermissionReviewer = {
            review: (_reviewCtx, request) => {
                seen.push(request);
                return Promise.resolve(allowedDecision());
            },
        };
        const { hooks } = await resolvedHooks({ reviewer });
        const throwingReview = testTool("throwing-review", {
            shouldReviewInAutoMode: () => {
                throw new Error("predicate failed");
            },
            describeAutoPermissionAction: () => "Should never reach the reviewer.",
        });
        const throwingElevation = testTool("throwing-elevation", {
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: () => {
                throw new Error("elevation predicate failed");
            },
            describeAutoPermissionAction: () => "Elevation check fails.",
        });
        const throwingDescription = testTool("throwing-description", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => {
                throw new Error("description failed");
            },
        });
        const blankDescription = testTool("blank-description", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => " \n\t ",
        });

        for (const [tool, text] of [
            [throwingReview, "permission check failed"],
            [throwingElevation, "permission check failed"],
            [throwingDescription, "action is not defined"],
            [blankDescription, "action is not defined"],
        ] as const) {
            const decision = await hooks.beforeToolCall?.(
                ctx,
                scope(`malformed-${tool.name}`, "auto"),
                call(tool),
            );
            expect(decision?.type).toBe("answer");
            expect(JSON.stringify(decision)).toContain(text);
        }
        expect(seen).toEqual([]);
    });

    it("normalizes a valid action description before review and event publication", async () => {
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => allowedDecision());
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const tool = testTool("trimmed", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "  Publish this file. \n",
        });

        await hooks.beforeToolCall?.(ctx, scope("trim-agent", "auto"), call(tool));
        expect(reviewer.seen[0]?.action).toBe("Publish this file.");
        expect(events[0]).toMatchObject({ action: "Publish this file." });
    });

    it("turns invalid reviewer verdicts into unproven refusals without running the tool", async () => {
        const events: PermissionEvent[] = [];
        const malformedVerdicts = [
            { outcome: "allowed", risk: "unknown", userAuthorization: "high" },
            { outcome: "allowed", userAuthorization: "high" },
            { outcome: "denied" },
            { outcome: "allowed", risk: "low", userAuthorization: "high", extra: true },
        ];

        for (const [index, verdict] of malformedVerdicts.entries()) {
            const reviewer: PermissionReviewer = {
                review: () => Promise.resolve(verdict as never),
            };
            const { hooks } = await resolvedHooks({
                reviewer,
                onEvent: (_eventCtx, event) => {
                    events.push(event);
                },
            });
            const tool = testTool(`invalid-${index}`, {
                shouldReviewInAutoMode: () => true,
                describeAutoPermissionAction: () => "Run malformed verdict test.",
            });
            const decision = await hooks.beforeToolCall?.(
                ctx,
                scope(`invalid-verdict-${index}`, "auto"),
                call(tool, {}, `invalid-call-${index}`),
            );
            expect(decision?.type).toBe("answer");
            expect(JSON.stringify(decision)).toContain("No judgement was made");
        }
        expect(events.filter((event) => event.type === "permission_action_unproven")).toHaveLength(
            malformedVerdicts.length,
        );
    });

    it("bounds hostile reviewer failures before they become event details", async () => {
        const events: PermissionEvent[] = [];
        const huge = "x".repeat(20_000);
        const reviewer: PermissionReviewer = {
            review: () => Promise.reject(new Error(huge)),
        };
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const tool = testTool("failing-reviewer", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Call with a failing reviewer.",
        });

        const decision = await hooks.beforeToolCall?.(
            ctx,
            scope("failing-reviewer-agent", "auto"),
            call(tool),
        );
        expect(decision?.type).toBe("answer");
        const event = events[0];
        expect(event?.type).toBe("permission_action_unproven");
        if (event?.type === "permission_action_unproven") {
            expect(event.reason.length).toBeLessThanOrEqual("The reviewer failed: ".length + 1_024);
            expect(event.reason).toMatch(/x{1024}$/u);
        }
    });

    it("detaches nested reviewer arguments and rejects unsupported or unbounded shapes", () => {
        const nested = {
            object: { list: [{ key: "value" }] },
        };
        const snapshot = snapshotPermissionArguments(nested) as {
            readonly object: { readonly list: readonly [{ readonly key: string }] };
        };
        expect(snapshot).not.toBe(nested);
        expect(snapshot.object).not.toBe(nested.object);
        expect(snapshot.object.list).not.toBe(nested.object.list);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.object)).toBe(true);
        expect(Object.isFrozen(snapshot.object.list)).toBe(true);
        expect(Object.isFrozen(snapshot.object.list[0])).toBe(true);

        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        expect(() => snapshotPermissionArguments(cycle)).toThrow();
        expect(() => snapshotPermissionArguments(new Date())).toThrow();
        expect(() => snapshotPermissionArguments(1n)).toThrow();
        expect(() =>
            snapshotPermissionArguments("x".repeat(MAX_PERMISSION_ARGUMENT_STRING + 1)),
        ).toThrow();
        expect(() =>
            snapshotPermissionArguments(
                Object.fromEntries(
                    Array.from({ length: MAX_PERMISSION_ARGUMENT_ITEMS + 1 }, (_, index) => [
                        `key-${index}`,
                        index,
                    ]),
                ),
            ),
        ).toThrow();

        let tooDeep: unknown = "leaf";
        for (let index = 0; index <= MAX_PERMISSION_ARGUMENT_DEPTH; index += 1) {
            tooDeep = [tooDeep];
        }
        expect(() => snapshotPermissionArguments(tooDeep)).toThrow();

        expect(() =>
            snapshotPermissionArguments({ value: "é".repeat(MAX_PERMISSION_ARGUMENT_BYTES) }),
        ).toThrow();
    });

    it("rejects non-finite numbers instead of handing a reviewer a lossy JSON snapshot", () => {
        expect(() => snapshotPermissionArguments(Number.NaN)).toThrow();
        expect(() => snapshotPermissionArguments(Number.POSITIVE_INFINITY)).toThrow();
        expect(() => snapshotPermissionArguments(Number.NEGATIVE_INFINITY)).toThrow();
        expect(Value.Check(reviewArgumentsSchema, Number.NaN)).toBe(false);
    });

    it("resets a refusal circuit after settlement and keeps allowed reviews from erasing its rate window", async () => {
        const circuit = new PermissionRefusalCircuitBreaker(2);
        expect(circuit.recordRefusal()).toMatchObject({
            consecutive: 1,
            recent: 1,
            window: 1,
            stopped: false,
        });
        expect(circuit.recordAllowed()).toBe(true);
        expect(circuit.status()).toMatchObject({
            consecutive: 0,
            recent: 1,
            window: 2,
        });
        for (let index = 0; index < 47; index += 1) circuit.recordAllowed();
        expect(circuit.status().recent).toBe(1);
        expect(circuit.status().window).toBe(49);
        circuit.recordRefusal();
        expect(circuit.status().recent).toBe(2);
        expect(circuit.status().window).toBe(50);

        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => deniedDecision());
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const tool = testTool("reset", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Reset circuit.",
        });
        const testScope = scope("reset-agent", "auto");
        // One refusal short of the bound, twice over, with a settlement between: the second run
        // starts from nothing, so together they never reach the bound a single run would.
        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING - 1; index += 1) {
            await hooks.beforeToolCall?.(ctx, testScope, call(tool, {}, `first-${index}`));
        }
        await hooks.afterAgentSettled?.(ctx, testScope, {} as never);
        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING - 1; index += 1) {
            await hooks.beforeToolCall?.(ctx, testScope, call(tool, {}, `second-${index}`));
        }

        expect(events.filter((event) => event.type === "permission_turn_stopped")).toHaveLength(0);
    });

    it("serializes concurrent decisions for one agent while allowing distinct agents to proceed", async () => {
        let active = 0;
        let maximumActive = 0;
        let startedFirst!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            startedFirst = resolve;
        });
        let releaseFirst!: () => void;
        const firstRelease = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let startedOther!: () => void;
        const otherStarted = new Promise<void>((resolve) => {
            startedOther = resolve;
        });
        const reviewer: PermissionReviewer = {
            review: async (_reviewCtx, request) => {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                if (request.agentId === "same-agent" && request.callId === "same-1") {
                    startedFirst();
                    await firstRelease;
                }
                if (request.agentId === "other-agent") startedOther();
                active -= 1;
                return allowedDecision();
            },
        };
        const { hooks } = await resolvedHooks({ reviewer });
        const tool = testTool("concurrent", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Review concurrent action.",
        });

        const first = hooks.beforeToolCall?.(
            ctx,
            scope("same-agent", "auto"),
            call(tool, {}, "same-1"),
        );
        await firstStarted;
        const second = hooks.beforeToolCall?.(
            ctx,
            scope("same-agent", "auto"),
            call(tool, {}, "same-2"),
        );
        const other = hooks.beforeToolCall?.(
            ctx,
            scope("other-agent", "auto"),
            call(tool, {}, "other-1"),
        );
        await otherStarted;
        expect(maximumActive).toBe(2);
        releaseFirst();
        await Promise.all([first, second, other]);
        expect(maximumActive).toBe(2);
    });

    it("does not charge malformed predicates or out-of-mode calls to the refusal circuit", async () => {
        const events: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => deniedDecision());
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const malformed = testTool("predicate", {
            shouldReviewInAutoMode: () => {
                throw new Error("broken");
            },
            describeAutoPermissionAction: () => "Never reviewed.",
        });
        const restricted = testTool("restricted", {
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Restricted.",
        });
        // Far more of both than the bound, so a circuit that charged them would have tripped long
        // before the reviewed refusals below.
        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING + 2; index += 1) {
            await hooks.beforeToolCall?.(
                ctx,
                scope("circuit-agent", "auto"),
                call(malformed, {}, `malformed-call-${index}`),
            );
            await hooks.beforeToolCall?.(
                ctx,
                scope("circuit-agent", "read_only"),
                call(restricted, {}, `restricted-call-${index}`),
            );
        }
        expect(events.some((event) => event.type === "permission_turn_stopped")).toBe(false);

        const reviewable = testTool("reviewable", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Actually reviewed.",
        });
        let decision;
        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING; index += 1) {
            decision = await hooks.beforeToolCall?.(
                ctx,
                scope("circuit-agent", "auto"),
                call(reviewable, {}, `reviewed-call-${index}`),
            );
        }
        expect(decision?.type).toBe("answer");
        expect(events.filter((event) => event.type === "permission_turn_stopped")).toHaveLength(1);
    });

    it("ends running commands only on permission reductions and keeps the full change event order", async () => {
        const events: PermissionEvent[] = [];
        const compute = new ScriptedCommandsComputeModule();
        const { hooks } = await resolvedHooks({
            compute,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        // Every agent in this test has two commands running under the wider mode.
        for (const suffix of [0, 1, 2]) compute.running(`reduction-${suffix}`, [11, 12]);
        for (const suffix of [0, 1, 2, 3]) compute.running(`no-reduction-${suffix}`, [21]);
        const reductions: readonly AgentBasePermissionModeChange[] = [
            { previousMode: "full_access", mode: "auto" },
            { previousMode: "auto", mode: "workspace_write" },
            { previousMode: "workspace_write", mode: "read_only" },
        ];
        const noReductions: readonly AgentBasePermissionModeChange[] = [
            { previousMode: "read_only", mode: "workspace_write" },
            { previousMode: "workspace_write", mode: "auto" },
            { previousMode: "auto", mode: "full_access" },
            { previousMode: "auto", mode: "auto" },
        ];

        for (const [index, change] of reductions.entries()) {
            await hooks.permissionModeChanged?.(
                ctx,
                scope(`reduction-${index}`, change.mode),
                change,
            );
        }
        for (const [index, change] of noReductions.entries()) {
            await hooks.permissionModeChanged?.(
                ctx,
                scope(`no-reduction-${index}`, change.mode),
                change,
            );
        }
        // Every command of every reduced agent was ended, and no command of any other agent was.
        expect(compute.stopped).toEqual([
            { agentId: "reduction-0", commandId: 11 },
            { agentId: "reduction-0", commandId: 12 },
            { agentId: "reduction-1", commandId: 11 },
            { agentId: "reduction-1", commandId: 12 },
            { agentId: "reduction-2", commandId: 11 },
            { agentId: "reduction-2", commandId: 12 },
        ]);
        expect(events.map((event) => event.type)).toEqual([
            "permission_mode_changed",
            "permission_mode_changed",
            "permission_mode_changed",
            "permission_mode_changed",
            "permission_mode_changed",
            "permission_mode_changed",
            "permission_mode_changed",
        ]);
    });

    it("contains hostile cleanup errors with a bounded fallback reason", async () => {
        const events: PermissionEvent[] = [];
        const hostile = Object.create(Error.prototype) as Error;
        Object.defineProperty(hostile, "message", {
            get: () => {
                throw new Error("message getter failed");
            },
        });
        const compute = new ScriptedCommandsComputeModule();
        compute.listFailure = hostile;
        const { hooks } = await resolvedHooks({
            compute,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });

        await hooks.permissionModeChanged?.(ctx, scope("hostile-cleanup-agent", "read_only"), {
            previousMode: "auto",
            mode: "read_only",
        });
        expect(events).toContainEqual({
            type: "permission_mode_cleanup_failed",
            agentId: "hostile-cleanup-agent",
            previousMode: "auto",
            mode: "read_only",
            reason: "The reviewer failed without a readable error.",
        });
    });

    it("delivers transactional mode events and per-call decisions to their documented listener phases", async () => {
        const transactional: PermissionEvent[] = [];
        const observed: PermissionEvent[] = [];
        const reviewer = reviewerAnswering(() => allowedDecision());
        const { hooks } = await resolvedHooks({
            reviewer,
            onEventTransactional: (_eventCtx, event) => {
                transactional.push(event);
            },
            onEvent: (_eventCtx, event) => {
                observed.push(event);
            },
        });
        const testScope = scope("phase-agent", "read_only");
        await hooks.permissionModeChangedTransact?.(ctx, testScope, {
            previousMode: "auto",
            mode: "read_only",
        });
        expect(transactional).toHaveLength(1);
        expect(observed).toHaveLength(0);

        const tool = testTool("phase-call", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Phase test.",
        });
        await hooks.beforeToolCall?.(ctx, scope("phase-agent", "auto"), call(tool));
        expect(transactional).toHaveLength(1);
        expect(observed).toHaveLength(1);
        expect(observed[0]?.type).toBe("permission_action_reviewed");
    });

    it("keeps a subscriber's own receiver, so a host can subscribe an object's method", async () => {
        // A subscription is a function, so a host that keeps its own state subscribes a bound
        // method. The module must not call it in a way that loses what it was bound to.
        const journal = {
            written: [] as PermissionEvent[],
            transacted: [] as PermissionEvent[],
            record(_eventCtx: Context, event: PermissionEvent): void {
                this.written.push(event);
            },
            recordTransactional(_eventCtx: Context, event: PermissionEvent): void {
                this.transacted.push(event);
            },
        };
        const { hooks } = await resolvedHooks({
            onEvent: journal.record.bind(journal),
            onEventTransactional: journal.recordTransactional.bind(journal),
        });
        const testScope = scope("receiver-agent", "read_only");
        const change = { previousMode: "auto", mode: "read_only" } as const;

        await hooks.permissionModeChangedTransact?.(ctx, testScope, change);
        await hooks.permissionModeChanged?.(ctx, testScope, change);

        expect(journal.transacted).toHaveLength(1);
        expect(journal.written).toHaveLength(1);
    });

    it("stops awaiting a listener that never settles, and lets the decision continue", async () => {
        vi.useFakeTimers();
        const warnings: string[] = [];
        const loggingContext = Object.create(ctx) as Context;
        Object.defineProperty(loggingContext, "log", {
            configurable: true,
            value: {
                ...ctx.log,
                warn: (message: string) => {
                    warnings.push(message);
                },
            },
        });
        let started!: () => void;
        const listenerEntered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const { hooks } = await resolvedHooks({
            onEvent: () => {
                started();
                // Never settles. Without the ceiling this would hold the mode change open forever.
                return new Promise<void>(() => {});
            },
        });

        const changed = hooks.permissionModeChanged?.(
            loggingContext,
            scope("wedged-listener-agent", "read_only"),
            { previousMode: "auto", mode: "read_only" },
        );
        await listenerEntered;
        await vi.advanceTimersByTimeAsync(PERMISSION_ANNOUNCE_TIMEOUT_MS);

        // Settling at all is the proof: the wedged observer no longer holds the decision.
        await expect(changed).resolves.toBeUndefined();
        expect(warnings.join("\n")).toContain("was not durably recorded");
    });

    it("treats a review that outlasts the budget as unproven rather than as unsafe", async () => {
        vi.useFakeTimers();
        const events: PermissionEvent[] = [];
        let reviewSignal: AbortSignal | undefined;
        let started!: () => void;
        const reviewEntered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const reviewer: PermissionReviewer = {
            review: (_reviewCtx, request) =>
                new Promise<PermissionReviewDecision>((resolve) => {
                    reviewSignal = request.signal;
                    started();
                    // A cooperative reviewer that answers when cancelled. Once the budget closed,
                    // that answer is a timeout rather than a late verdict.
                    request.signal.addEventListener("abort", () => resolve(allowedDecision()));
                }),
        };
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const tool = testTool("slow-review", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Take too long about it.",
        });

        const pending = hooks.beforeToolCall?.(ctx, scope("timeout-agent", "auto"), call(tool));
        await reviewEntered;
        await vi.advanceTimersByTimeAsync(PERMISSION_REVIEW_TIMEOUT_MS);
        const decision = await pending;

        expect(reviewSignal?.aborted).toBe(true);
        expect(decision?.type).toBe("answer");
        // Unproven, not unsafe: the model is told the timeout is not a verdict, and may retry once.
        expect(JSON.stringify(decision)).toContain("did not finish in time");
        expect(JSON.stringify(decision)).toContain(
            "do not treat the timeout by itself as a verdict",
        );
        expect(events[0]).toMatchObject({
            type: "permission_action_unproven",
            kind: "timed_out",
            reason: "The reviewer did not answer within 90 seconds.",
        });
    });

    it("rolls back a permission-mode change when its transactional listener fails", async () => {
        const world = await agentWorld();
        const provider = new ScriptedProvider([textTurn("noted")]);
        const events: PermissionEvent[] = [];
        let transactionalCalls = 0;
        const permissions = new PermissionsModule(new ScriptedCommandsComputeModule());
        permissions.onEventTransactional(() => {
            transactionalCalls += 1;
            throw new Error("transactional listener failed");
        });
        permissions.onEvent((_eventCtx, event) => {
            events.push(event);
        });
        const system = await AgentSystemLocal.create(ctx, world.storage, {
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
            modules: [permissions],
        });
        const agent = await system.create(ctx, {});
        const accepted = agent.steer(
            ctx,
            {
                role: "user",
                content: [{ type: "text", text: permissionModeChangeNotice("read_only") }],
            },
            { permissionMode: "read_only" },
        );
        await accepted;
        await agent.waitForIdle();
        const settings = await world.storage.persistence(agent.id).readValues(ctx, "settings");
        expect(transactionalCalls).toBeGreaterThanOrEqual(1);
        expect(settings).toHaveLength(0);
        expect(events).toEqual([]);
        await system.close(ctx);
    });

    it("cancels a review as stopped rather than treating cancellation as a refusal or timeout", async () => {
        const events: PermissionEvent[] = [];
        let reviewStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            reviewStarted = resolve;
        });
        let reviewSignal: AbortSignal | undefined;
        const reviewer: PermissionReviewer = {
            review: (_reviewCtx, request) =>
                new Promise<PermissionReviewDecision>((resolve) => {
                    reviewSignal = request.signal;
                    reviewStarted();
                    request.signal.addEventListener("abort", () => resolve(allowedDecision()));
                }),
        };
        const { hooks } = await resolvedHooks({
            reviewer,
            onEvent: (_eventCtx, event) => {
                events.push(event);
            },
        });
        const controller = new AbortController();
        const cancelledContext = Object.create(ctx) as Context;
        Object.defineProperty(cancelledContext, "lifetime", {
            configurable: true,
            value: controller.signal,
        });
        const reviewTool = testTool("cancel-review", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Cancel this review.",
        });
        const decisionPromise = hooks.beforeToolCall?.(
            cancelledContext,
            scope("cancel-review-agent", "auto"),
            call(reviewTool),
        );
        await started;
        controller.abort();
        const decision = await decisionPromise;

        expect(reviewSignal?.aborted).toBe(true);
        expect(decision?.type).toBe("answer");
        expect(JSON.stringify(decision)).toContain("Permission review was stopped");
        expect(events).toEqual([]);
    });

    it("reports exact bounded turn-stop counts when a direct hook owns the system abort seam", async () => {
        const events: PermissionEvent[] = [];
        const aborted: string[] = [];
        const reviewer = reviewerAnswering(() => deniedDecision());
        const permissions = new PermissionsModule(
            new ScriptedCommandsComputeModule(),
            autoWith(reviewer),
        );
        permissions.onEvent((_eventCtx, event) => {
            events.push(event);
        });
        const agents = {
            abort: async (_abortCtx: Context, agentId: string) => {
                aborted.push(agentId);
            },
        };
        const hooks = await permissions.beforeStart?.(ctx, agents as never);
        const tool = testTool("stop-direct", {
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: () => "Stop direct.",
        });
        const bound = PERMISSION_REFUSALS_BEFORE_STOPPING;
        for (let index = 0; index < bound; index += 1) {
            await hooks?.beforeToolCall?.(
                ctx,
                scope("stop-direct-agent", "auto"),
                call(tool, {}, `stop-direct-${index}`),
            );
        }
        expect(aborted).toEqual(["stop-direct-agent"]);
        expect(events).toContainEqual(
            expect.objectContaining({
                type: "permission_turn_stopped",
                consecutiveRefusals: bound,
                recentRefusals: bound,
                recentWindowLength: bound,
                reason: permissionTurnStoppedReason(bound, bound, bound),
            }),
        );
    });
});
