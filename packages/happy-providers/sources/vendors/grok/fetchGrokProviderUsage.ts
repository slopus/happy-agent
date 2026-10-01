import type { ProviderUsage, ProviderUsageCredits } from "@/core/ProviderUsage.js";
import {
    epochMsFromIso,
    optionalResponseJson,
    providerPlanName,
    providerUsageWindow,
    usagePercent,
} from "@/core/providerUsageValues.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { GROK_OAUTH_SCOPE, readGrokAuthStore, getGrokAuthPath } from "@/vendors/grok/impl/auth.js";
import { GROK_BUILD_CLIENT_VERSION } from "@/vendors/grok/impl/grokConstants.js";

const DEFAULT_GROK_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchGrokProviderUsageOptions {
    authFile?: string;
    baseUrl?: string;
    clientVersion?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    providerId?: string;
    timeoutMs?: number;
}

/**
 * Reads one Grok account's credit usage and subscription tier from the CLI
 * chat proxy. Returns null when the account cannot be read.
 */
export async function fetchGrokProviderUsage(
    options: FetchGrokProviderUsageOptions = {},
): Promise<ProviderUsage | null> {
    const now = options.now ?? Date.now;
    try {
        const credential = await GrokSessionCredential.tryLoad({
            ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
            ...(options.env === undefined ? {} : { env: options.env }),
        });
        if (credential === null) return null;
        // The stored token is short lived, so a stale one is renewed before use
        // rather than being reported as an unreadable account.
        await credential.ensureFresh();

        const authPath = getGrokAuthPath({
            ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
            env: options.env ?? process.env,
        });
        const record = (await readGrokAuthStore(authPath))[GROK_OAUTH_SCOPE];
        const headers = new Headers({
            authorization: `Bearer ${credential.credential.token}`,
            "x-xai-token-auth": "xai-grok-cli",
            "x-grok-client-version": options.clientVersion ?? GROK_BUILD_CLIENT_VERSION,
        });
        const userId = record?.["user_id"];
        if (typeof userId === "string") headers.set("x-userid", userId);

        const baseUrl = (options.baseUrl ?? DEFAULT_GROK_PROXY_BASE_URL).replace(/\/+$/u, "");
        const doFetch = options.fetch ?? fetch;
        const request = (path: string): Promise<Response> =>
            doFetch(`${baseUrl}${path}`, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });

        const [billing, user] = await Promise.all([
            request("/billing?format=credits"),
            // The tier is a separate call; a failure there only costs the plan name.
            request("/user?include=subscription").catch(() => null),
        ]);
        if (!billing.ok) return null;
        const userPayload = await optionalResponseJson(user);

        return parseGrokProviderUsage(await billing.json(), userPayload, {
            capturedAt: now(),
            providerId: options.providerId ?? "grok",
        });
    } catch {
        return null;
    }
}

interface GrokCentPayload {
    val?: unknown;
}

interface GrokBillingPayload {
    config?: {
        billingPeriodEnd?: unknown;
        billingPeriodStart?: unknown;
        creditUsagePercent?: unknown;
        currentPeriod?: { type?: unknown; start?: unknown; end?: unknown } | null;
        onDemandCap?: GrokCentPayload | null;
        onDemandUsed?: GrokCentPayload | null;
        prepaidBalance?: GrokCentPayload | null;
    } | null;
    subscriptionTier?: unknown;
}

export function parseGrokProviderUsage(
    billing: unknown,
    user: unknown,
    context: { capturedAt: number; providerId: string },
): ProviderUsage {
    const body = (billing ?? {}) as GrokBillingPayload;
    const config = body.config ?? {};
    const startsAt =
        epochMsFromIso(config.currentPeriod?.start) ?? epochMsFromIso(config.billingPeriodStart);
    const resetsAt =
        epochMsFromIso(config.currentPeriod?.end) ?? epochMsFromIso(config.billingPeriodEnd);
    const window = providerUsageWindow({
        usedPercent: config.creditUsagePercent,
        resetsAt,
        startsAt,
        durationMs: startsAt !== null && resetsAt !== null ? resetsAt - startsAt : null,
    });
    const windows: ProviderUsage["windows"] = { fiveHour: null, weekly: null, monthly: null };
    windows[grokPeriodName(config.currentPeriod?.type)] = window;

    const credits = parseGrokCredits(config);
    const percent = usagePercent(config.creditUsagePercent);
    const tier =
        (user as { subscriptionTier?: unknown } | null)?.subscriptionTier ?? body.subscriptionTier;

    return {
        providerId: context.providerId,
        vendor: "grok",
        capturedAt: context.capturedAt,
        planName: providerPlanName(tier),
        exhausted: percent !== null && percent >= 100 && credits?.available !== true,
        windows,
        credits,
    };
}

/** Grok reports one billing period whose length it names explicitly. */
function grokPeriodName(type: unknown): keyof ProviderUsage["windows"] {
    return type === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly" : "weekly";
}

function cents(payload: GrokCentPayload | null | undefined): number | null {
    const value = payload?.val;
    // proto3 JSON omits zero-valued scalars, so a present but empty cent is $0.
    if (payload != null && value === undefined) return 0;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseGrokCredits(
    config: NonNullable<GrokBillingPayload["config"]>,
): ProviderUsageCredits | null {
    const prepaid = cents(config.prepaidBalance);
    const cap = cents(config.onDemandCap);
    const used = cents(config.onDemandUsed);
    if (prepaid === null && cap === null) return null;
    const onDemandRemaining = cap === null ? 0 : cap - (used ?? 0);
    const remainingCents = (prepaid ?? 0) + onDemandRemaining;
    return {
        available: remainingCents > 0,
        remainingCents,
        unlimited: false,
        usedPercent: null,
    };
}
