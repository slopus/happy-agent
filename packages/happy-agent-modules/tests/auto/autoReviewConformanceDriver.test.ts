import { describe, expect, it, vi } from "vitest";

import { AutoReviewProvider } from "../../sources/auto/impl/AutoReviewProvider.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import {
    conformanceRequest,
    runAutoReviewConformance,
} from "./support/runAutoReviewConformance.js";

function verdict(outcome: "allow" | "deny", authorization = "high", risk = "low") {
    return [
        {
            type: "text_delta" as const,
            delta: JSON.stringify({
                outcome,
                risk_level: risk,
                user_authorization: authorization,
                rationale: "Synthetic policy decision.",
            }),
        },
        { type: "done" as const, state: "normal" as const, tokens: { input: 1, output: 1 } },
    ];
}

describe("the opt-in conformance driver's bounds", () => {
    it("uses three serial schema requests with synthetic policy and provenance only", async () => {
        const original = new ScriptedProvider([
            verdict("allow"),
            verdict("deny"),
            verdict("deny", "unknown"),
        ]);
        const provider = new AutoReviewProvider(original);
        const records: Readonly<Record<string, unknown>>[] = [];
        await runAutoReviewConformance(
            (id, options) => provider.session(id, options),
            (record) => records.push(record),
        );
        expect(original.sessions).toHaveLength(3);
        expect(
            original.sessions.every(
                (session) => session.options.tools?.length === 0 && session.requests.length === 1,
            ),
        ).toBe(true);
        expect(
            original.sessions.map((session) => session.requests[0]?.structuredOutput?.name),
        ).toEqual(["permission_review", "permission_review", "permission_review"]);
        expect(records.map((record) => record.clientRequests)).toEqual([1, 2, 3]);
        const security = await conformanceRequest(1);
        expect(security.context.instructions).toContain(
            "## Project AGENTS_SECURITY.md\n\nDeny every read",
        );
        const untrusted = JSON.stringify((await conformanceRequest(2)).context.messages);
        expect(untrusted).toContain("[1] User:\\nSummarize the synthetic repository fixture only.");
        expect(untrusted).toContain("[2] Tool result (read_file):");
    });

    it.each([
        [{ type: "text_delta" as const, delta: "<review><outcome>allow</outcome></review>" }],
        [{ type: "text_delta" as const, delta: "é".repeat(9_000) }],
        [
            {
                type: "done" as const,
                state: "error" as const,
                kind: "unknown" as const,
                message: "SECRET_RAW_PROVIDER_ERROR",
            },
        ],
        [{ type: "toolcall_start" as const, name: "unexpected", callId: "never-executed" }],
        [{ type: "retrying" as const, attempt: 1, reason: "SECRET_RAW_RETRY_REASON" }],
    ])(
        "stops at the first nonconformance without retaining provider diagnostics",
        async (event) => {
            const original = new ScriptedProvider([[event], verdict("allow")]);
            const provider = new AutoReviewProvider(original);
            const records: Readonly<Record<string, unknown>>[] = [];
            await expect(
                runAutoReviewConformance(
                    (id, options) => provider.session(id, options),
                    (record) => records.push(record),
                ),
            ).rejects.toThrow("provider details omitted");
            expect(original.sessions).toHaveLength(1);
            expect(original.sessions[0]?.requests).toHaveLength(1);
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ status: "stopped", clientRequests: 1 });
            expect(JSON.stringify(records)).not.toContain("SECRET_RAW");
            expect(Number(records[0]?.bytes)).toBeLessThanOrEqual(16 * 1024);
        },
    );

    it("aborts a held stream at the deadline and starts no later request", async () => {
        vi.useFakeTimers();
        try {
            let aborted = false;
            const original = new ScriptedProvider([
                (ctx) =>
                    (async function* () {
                        await new Promise<void>((resolve) =>
                            ctx.lifetime!.addEventListener(
                                "abort",
                                () => {
                                    aborted = true;
                                    resolve();
                                },
                                { once: true },
                            ),
                        );
                    })(),
            ]);
            const provider = new AutoReviewProvider(original);
            const records: Readonly<Record<string, unknown>>[] = [];
            const run = runAutoReviewConformance(
                (id, options) => provider.session(id, options),
                (record) => records.push(record),
            );
            const assertion = expect(run).rejects.toThrow("provider details omitted");
            await vi.advanceTimersByTimeAsync(30_000);
            await assertion;
            expect(aborted).toBe(true);
            expect(original.sessions).toHaveLength(1);
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ status: "stopped", clientRequests: 1 });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([0, 1])("stops if read case %i is not classified as low risk", async (index) => {
        const original = new ScriptedProvider(
            index === 0
                ? [verdict("allow", "high", "medium"), verdict("deny")]
                : [verdict("allow"), verdict("deny", "high", "medium"), verdict("deny", "unknown")],
        );
        const provider = new AutoReviewProvider(original);
        const records: Readonly<Record<string, unknown>>[] = [];
        await expect(
            runAutoReviewConformance(
                (id, options) => provider.session(id, options),
                (record) => records.push(record),
            ),
        ).rejects.toThrow("provider details omitted");
        expect(original.sessions).toHaveLength(index + 1);
        expect(original.sessions.every((session) => session.requests.length === 1)).toBe(true);
        expect(records.at(-1)).toMatchObject({ status: "stopped", clientRequests: index + 1 });
    });

    it("bounds a hung factory and never runs a session that arrives after cancellation", async () => {
        vi.useFakeTimers();
        try {
            const original = new ScriptedProvider([verdict("allow")]);
            const session = await original.session("late", { instructions: "", tools: [] });
            const destroy = vi.spyOn(session, "destroy");
            let completeFactory: ((value: typeof session) => void) | undefined;
            const factory = vi.fn(
                () =>
                    new Promise<typeof session>((resolve) => {
                        completeFactory = resolve;
                    }),
            );
            const records: Readonly<Record<string, unknown>>[] = [];
            const assertion = expect(
                runAutoReviewConformance(factory, (record) => records.push(record)),
            ).rejects.toThrow("provider details omitted");
            await vi.advanceTimersByTimeAsync(30_000);
            await assertion;
            expect(factory).toHaveBeenCalledTimes(1);
            expect(records).toEqual([
                expect.objectContaining({
                    status: "stopped",
                    clientRequests: 0,
                    elapsedMs: 30_000,
                }),
            ]);
            completeFactory!(session);
            await vi.advanceTimersByTimeAsync(0);
            expect(original.sessions[0]?.requests).toHaveLength(0);
            expect(destroy).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("bounds a hung destroy and starts no later case", async () => {
        vi.useFakeTimers();
        try {
            const original = new ScriptedProvider([verdict("allow")]);
            const factory = vi.fn(async (id, options) => {
                const session = await original.session(id, options);
                vi.spyOn(session, "destroy").mockImplementation(() => new Promise<void>(() => {}));
                return session;
            });
            const records: Readonly<Record<string, unknown>>[] = [];
            const assertion = expect(
                runAutoReviewConformance(factory, (record) => records.push(record)),
            ).rejects.toThrow("provider details omitted");
            await vi.advanceTimersByTimeAsync(2_000);
            await assertion;
            expect(factory).toHaveBeenCalledTimes(1);
            expect(records).toEqual([
                expect.objectContaining({
                    status: "stopped",
                    clientRequests: 1,
                    cleanup: "timed_out",
                    elapsedMs: 2_000,
                }),
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("shares one absolute 90-second budget across setup, inference, and cleanup", async () => {
        vi.useFakeTimers();
        try {
            const original = new ScriptedProvider([
                ...[verdict("allow"), verdict("deny"), verdict("deny", "unknown")].map(
                    (events) => () =>
                        (async function* () {
                            await new Promise<void>((resolve) => setTimeout(resolve, 29_000));
                            yield* events;
                        })(),
                ),
            ]);
            const factory = vi.fn(async (id, options) => {
                const session = await original.session(id, options);
                vi.spyOn(session, "destroy").mockImplementation(
                    () => new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
                );
                return session;
            });
            const records: Readonly<Record<string, unknown>>[] = [];
            const assertion = expect(
                runAutoReviewConformance(factory, (record) => records.push(record)),
            ).rejects.toThrow("provider details omitted");
            await vi.advanceTimersByTimeAsync(90_000);
            await assertion;
            expect(factory).toHaveBeenCalledTimes(3);
            expect(records).toHaveLength(3);
            expect(records[2]).toMatchObject({
                status: "stopped",
                clientRequests: 3,
                cleanup: "timed_out",
                overallElapsedMs: 90_000,
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
