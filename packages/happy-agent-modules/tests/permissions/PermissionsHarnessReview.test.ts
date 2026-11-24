import { withAgentPermissionMode, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { AutoModule } from "../../sources/auto/index.js";
import type {
    ConfigModule,
    HarnessPermissionAsk,
    HarnessPermissionReviewer,
} from "../../sources/config/index.js";
import {
    PERMISSION_REFUSALS_BEFORE_STOPPING,
    PermissionsModule,
    type PermissionEvent,
    type PermissionReviewDecision,
    type PermissionReviewRequest,
    type PermissionReviewer,
} from "../../sources/permissions/index.js";
import { ScriptedCommandsComputeModule } from "../support/computeModule.js";

const root = createRootContext().named("happy-agent-modules-permissions-harness-review");

const ask: HarnessPermissionAsk = {
    agentId: "harness-agent",
    harnessId: "antigravity",
    harnessName: "Antigravity",
    action: "Write /tmp/scratch/notes.txt",
    allowForSession: true,
};

function inMode(mode: AgentPermissionMode): Context {
    return withAgentPermissionMode(root, mode);
}

/** A permissions module wired the way the runtime wires it, with what it registered on config. */
async function harnessReview(
    review: (request: PermissionReviewRequest) => Promise<PermissionReviewDecision>,
) {
    const seen: PermissionReviewRequest[] = [];
    const reviewer: PermissionReviewer = {
        review: (_reviewCtx, request) => {
            seen.push(request);
            return review(request);
        },
    };
    let registered: HarnessPermissionReviewer | undefined;
    const config = {
        onHarnessPermissionReview: (next: HarnessPermissionReviewer) => {
            registered = next;
            return () => undefined;
        },
    } as unknown as ConfigModule;
    const auto = { reviewer, globalSecurityPath: "/home/me/.happy/SECURITY.md" };
    const permissions = new PermissionsModule(
        new ScriptedCommandsComputeModule(),
        auto as unknown as AutoModule,
        config,
    );
    const events: PermissionEvent[] = [];
    permissions.onEvent((_eventCtx, event) => {
        events.push(event);
    });
    const aborted: string[] = [];
    await permissions.beforeStart(root, {
        abort: async (_abortCtx: Context, agentId: string) => {
            aborted.push(agentId);
        },
    } as never);
    if (registered === undefined) throw new Error("Permissions registered no harness reviewer.");
    const decide = registered;
    return {
        seen,
        events,
        aborted,
        decide: (mode: AgentPermissionMode, signal = new AbortController().signal) =>
            decide(inMode(mode), ask, signal),
    };
}

const allowed: PermissionReviewDecision = {
    outcome: "allowed",
    risk: "low",
    userAuthorization: "high",
};
const denied: PermissionReviewDecision = {
    outcome: "denied",
    reason: "Nobody asked for this write.",
    risk: "high",
    userAuthorization: "unknown",
};

describe("a foreign harness's permission ask in Auto", () => {
    it("is approved once when Happy's reviewer allows it, never elevated", async () => {
        const harness = await harnessReview(() => Promise.resolve(allowed));

        expect(await harness.decide("auto")).toEqual({ outcome: "allowed" });
        expect(harness.seen).toHaveLength(1);
        expect(harness.seen[0]).toMatchObject({
            agentId: "harness-agent",
            tool: { namespace: "harness", name: "antigravity" },
            elevates: false,
            mode: "auto",
        });
        // The reviewer learns who asks, that it acts outside the sandbox, and what it wants.
        expect(harness.seen[0]?.action).toContain("Antigravity");
        expect(harness.seen[0]?.action).toContain("outside Happy's sandbox");
        expect(harness.seen[0]?.action).toContain("Write /tmp/scratch/notes.txt");
    });

    it("is refused with Happy's own refusal text when the reviewer denies it", async () => {
        const harness = await harnessReview(() => Promise.resolve(denied));

        const review = await harness.decide("auto");
        expect(review.outcome).toBe("denied");
        const reason = review.outcome === "denied" ? review.reason : "";
        expect(reason).toContain("Automatic permission review refused");
        expect(reason).toContain("Reason: Nobody asked for this write.");
        expect(reason).toContain("Do not pursue the same outcome by another route");
        expect(reason).toContain("/home/me/.happy/SECURITY.md");
    });

    it("is refused when an allow fails Happy's own risk policy", async () => {
        const harness = await harnessReview(() =>
            Promise.resolve({ outcome: "allowed", risk: "high", userAuthorization: "low" }),
        );

        expect((await harness.decide("auto")).outcome).toBe("denied");
    });

    it("goes to the person when the reviewer fails or no route is available", async () => {
        const harness = await harnessReview(() =>
            Promise.reject(new Error("No automatic permission reviewer route was available.")),
        );

        expect(await harness.decide("auto")).toEqual({ outcome: "escalate" });
        // A reviewer that decided nothing is no refusal: the circuit does not move.
        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING; index += 1) {
            expect(await harness.decide("auto")).toEqual({ outcome: "escalate" });
        }
        expect(harness.aborted).toEqual([]);
    });

    it("goes to the person, unreviewed, in every mode but Auto", async () => {
        const harness = await harnessReview(() => Promise.resolve(allowed));

        for (const mode of ["read_only", "workspace_write", "full_access"] as const) {
            expect(await harness.decide(mode)).toEqual({ outcome: "escalate" });
        }
        expect(harness.seen).toHaveLength(0);
    });

    it("withdraws to the person when the turn stops during the review", async () => {
        const controller = new AbortController();
        const harness = await harnessReview(
            (request) =>
                new Promise((resolve) => {
                    request.signal.addEventListener("abort", () => resolve(allowed));
                    controller.abort();
                }),
        );

        expect(await harness.decide("auto", controller.signal)).toEqual({ outcome: "escalate" });
    });

    it("stops the turn after repeated refusals, sharing the circuit with Happy's own calls", async () => {
        const harness = await harnessReview(() => Promise.resolve(denied));

        for (let index = 0; index < PERMISSION_REFUSALS_BEFORE_STOPPING; index += 1) {
            expect((await harness.decide("auto")).outcome).toBe("denied");
        }
        expect(harness.aborted).toEqual(["harness-agent"]);
        expect(harness.events.map((event) => event.type)).toEqual(["permission_turn_stopped"]);
        // Once tripped, the next ask is refused without another review.
        const seen = harness.seen.length;
        const next = await harness.decide("auto");
        expect(next.outcome).toBe("denied");
        expect(harness.seen).toHaveLength(seen);
    });
});
