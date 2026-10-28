import { Value } from "@sinclair/typebox/value";
import { isKnownMessageFailure, messageFailureSchema } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import type { ProviderExecutionAttempt } from "../../sources/config/index.js";
import { messageFailure, relativeTime } from "../../sources/history/impl/messageFailure.js";

const now = Date.UTC(2026, 9, 20, 12, 0, 0);
const provider = { id: "claude", type: "claude", vendorName: "Claude", label: "claude" };
const attempt = (fields: Partial<ProviderExecutionAttempt>): ProviderExecutionAttempt => ({
    mode: {
        providerId: "claude",
        modelId: "anthropic/opus-5-5",
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    },
    credentialSource: null,
    ...fields,
});
const build = (fields: Partial<Parameters<typeof messageFailure>[0]>) =>
    messageFailure({
        text: "Upstream said no.",
        attempt: undefined,
        unavailable: undefined,
        provider,
        disabled: false,
        spentPool: undefined,
        now,
        ...fields,
    });

describe("a failed turn's typed failure", () => {
    it.each([
        [
            "authentication_failed",
            {
                kind: "signin_missing",
                message: "Claude Code isn't signed in. Run claude auth login, then retry.",
                product: "Claude Code",
                command: "claude auth login",
            },
        ],
        [
            "rate_limit",
            { kind: "rate_limited", message: "Claude is rate-limited. Try again in a minute." },
        ],
        [
            "server_overloaded",
            {
                kind: "provider_unavailable",
                message: "Claude is overloaded right now. Try again in a moment.",
            },
        ],
        ["internal_server_error", { kind: "provider_unavailable" }],
        ["empty_response", { kind: "provider_unavailable" }],
        [
            "network",
            {
                kind: "network",
                message: "Couldn't reach Claude. Check your connection, then retry.",
            },
        ],
        [
            "unclassified",
            {
                kind: "internal",
                message: "Upstream said no.",
                detail: "Upstream said no.",
            },
        ],
    ] as const)("maps %s to its kind", (errorCode, expected) => {
        const failure = build({
            attempt: attempt({
                errorCode,
                signIn: { product: "Claude Code", command: "claude auth login" },
            }),
        });
        // Switch targets and usage are live data; a failure never carries a snapshot of them.
        expect(failure).toMatchObject({ ...expected, fallbackProviders: [] });
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("names the reset as a duration, never a clock time", () => {
        const resetsAt = now + 2 * 60 * 60_000;
        const failure = build({ attempt: attempt({ errorCode: "out_of_tokens", resetsAt }) });
        expect(failure).toMatchObject({
            kind: "usage_limit",
            message: "Claude usage limit reached. It resets in about 2 hours.",
            resetsAt,
        });
        expect(failure.message).not.toMatch(/\d{1,2}:\d{2}|UTC|GMT|AM|PM|T\d{2}/u);
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("leaves an unknown reset out of the sentence", () => {
        expect(build({ attempt: attempt({ errorCode: "out_of_tokens" }) })).toMatchObject({
            message: "Claude usage limit reached.",
            resetsAt: null,
        });
    });

    it("calls a throttle on an account its vendor reports spent a usage limit", () => {
        // Oct 21 2026 6pm America/Los_Angeles, the weekly reset Claude Code named.
        const weeklyReset = 1_792_630_800_000;
        const throttled = attempt({ errorCode: "rate_limit", resetsAt: now + 60_000 });
        const failure = build({ attempt: throttled, spentAccount: { resetsAt: weeklyReset } });
        expect(failure).toMatchObject({
            kind: "usage_limit",
            message: "Claude usage limit reached. It resets in about 37 hours.",
            provider,
            resetsAt: weeklyReset,
        });
        expect(isKnownMessageFailure(failure)).toBe(true);
        // Without a reset of its own, the reading still outranks a guess.
        expect(build({ attempt: throttled, spentAccount: { resetsAt: null } })).toMatchObject({
            kind: "usage_limit",
            resetsAt: now + 60_000,
        });
        // An account nobody reported spent is only throttled.
        expect(build({ attempt: throttled })).toMatchObject({
            kind: "rate_limited",
            message: "Claude is rate-limited. Try again in a minute.",
        });
        // A vendor's own usage-limit verdict keeps its own reset.
        expect(
            build({
                attempt: attempt({ errorCode: "out_of_tokens", resetsAt: weeklyReset }),
                spentAccount: { resetsAt: now + 60_000 },
            }),
        ).toMatchObject({ kind: "usage_limit", resetsAt: weeklyReset });
        // A sign-in problem is not hidden behind a spent reading.
        expect(
            build({
                attempt: attempt({ errorCode: "authentication_failed" }),
                spentAccount: { resetsAt: weeklyReset },
            }).kind,
        ).toBe("signin_missing");
    });

    it("names the model a chat outgrew, ahead of a spent pool or a disabled route", () => {
        const failure = build({
            disabled: true,
            spentPool: { name: "claude-pool", resetsAt: null },
            attempt: attempt({ errorCode: "inference_failed", contextOverflow: true }),
        });
        expect(failure).toMatchObject({
            kind: "context_too_long",
            modelId: "anthropic/opus-5-5",
            message: "This chat no longer fits the model's context window, so start a new chat.",
        });
        expect(isKnownMessageFailure(failure)).toBe(true);
    });

    it("says a custom source needs its settings checked", () => {
        expect(
            build({
                attempt: attempt({
                    errorCode: "authentication_failed",
                    signIn: { product: null, command: null },
                }),
            }),
        ).toMatchObject({
            kind: "signin_missing",
            message: "claude couldn't authenticate. Check its sign-in settings, then retry.",
            product: null,
            command: null,
        });
    });

    it("uses configuration's missing credential when no attempt exists", () => {
        const failure = build({
            unavailable: {
                providerId: "claude",
                signIn: { product: "Grok", command: "grok login" },
                error: {
                    code: "credentials_unavailable",
                    mode: null,
                    credentialSource: null,
                    recovery: { steps: ["Sign in."], actions: ["ask_chief"] },
                },
            },
        });
        expect(failure).toMatchObject({ kind: "signin_missing", command: "grok login" });
    });

    it("says a turned-off route needs turning on before any attempt", () => {
        const failure = build({ disabled: true });
        expect(failure).toMatchObject({
            kind: "provider_disabled",
            message: "claude is turned off. Turn it on in settings, then retry.",
            provider,
        });
        expect(isKnownMessageFailure(failure)).toBe(true);
        // An attempt that reached the provider reports what the provider said instead.
        expect(build({ disabled: true, attempt: attempt({ errorCode: "rate_limit" }) }).kind).toBe(
            "rate_limited",
        );
    });

    it("names a spent pool and when its first account resets", () => {
        const resetsAt = now + 3 * 60 * 60_000;
        const failure = build({
            spentPool: { name: "claude-pool", resetsAt },
            attempt: attempt({ errorCode: "out_of_tokens", resetsAt: now + 9 * 60 * 60_000 }),
        });
        expect(failure).toMatchObject({
            kind: "no_account_available",
            message: "No claude-pool account is available. The first one resets in about 3 hours.",
            poolName: "claude-pool",
            resetsAt,
        });
        expect(isKnownMessageFailure(failure)).toBe(true);
        expect(build({ spentPool: { name: "claude-pool", resetsAt: null } })).toMatchObject({
            kind: "no_account_available",
            message: "No claude-pool account is available.",
            resetsAt: null,
        });
    });

    it("lists what happened to each account of a spent pool", () => {
        const members = [
            { provider, reason: "usage_limit", command: null, resetsAt: now + 60 * 60_000 },
            {
                provider: { ...provider, id: "claude_work", label: "Work" },
                reason: "usage_limit",
                command: null,
                resetsAt: null,
            },
        ];
        const failure = build({ spentPool: { name: "claude-pool", resetsAt: null, members } });
        expect(failure).toMatchObject({ kind: "no_account_available", members });
        expect(isKnownMessageFailure(failure)).toBe(true);
        // A pool with every account turned off has none to list.
        expect(
            build({ spentPool: { name: "claude-pool", resetsAt: null, members: [] } }),
        ).toMatchObject({ kind: "no_account_available", members: [] });
        expect(build({ spentPool: { name: "claude-pool", resetsAt: null } })).not.toHaveProperty(
            "members",
        );
    });

    it("keeps a sign-in or overload ahead of a spent pool", () => {
        const spentPool = { name: "claude-pool", resetsAt: null };
        expect(
            build({ spentPool, attempt: attempt({ errorCode: "authentication_failed" }) }).kind,
        ).toBe("signin_missing");
        expect(
            build({ spentPool, attempt: attempt({ errorCode: "server_overloaded" }) }).kind,
        ).toBe("provider_unavailable");
    });

    it("keeps only a bounded first line of an unclassified error", () => {
        const failure = build({ text: `\n${"x".repeat(900)}\nsecond line` });
        expect(failure.kind).toBe("internal");
        expect(failure.message.length).toBeLessThanOrEqual(512);
        expect(Value.Check(messageFailureSchema, failure)).toBe(true);
        expect(JSON.stringify(failure)).not.toContain("second line");
    });

    it.each([
        [30_000, "in under a minute"],
        [60_000, "in about 1 minute"],
        [45 * 60_000, "in about 45 minutes"],
        [90 * 60_000, "in about 2 hours"],
        [47 * 60 * 60_000, "in about 47 hours"],
        [3 * 24 * 60 * 60_000, "in about 3 days"],
    ])("describes a reset %d ms away as %s", (delta, text) => {
        expect(relativeTime(now + delta, now)).toBe(text);
    });
});
