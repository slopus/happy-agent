import { createTimedSignal } from "../../impl/createTimedSignal.js";
import { readBoundedResponseText } from "./readBoundedResponseText.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/**
 * The Interactions API revision every request is pinned to.
 *
 * The API is in beta and Google's own examples send this, so a later revision that changes the
 * request or response shape cannot silently break Rig's calls.
 */
const GEMINI_API_REVISION = "2026-05-20";

export interface RequestGeminiInteractionOptions {
    apiKey: string;
    body: unknown;
    fetch?: typeof fetch;
    maximumResponseBytes: number;
    operation: string;
    signal?: AbortSignal;
    timeoutMs: number;
}

/**
 * One call to Gemini's Interactions API.
 *
 * The key travels in the header rather than in the body, every operation carries its own deadline
 * because generating a song takes far longer than describing a photograph, and a failure is
 * reported with Gemini's own message so the model can act on what actually went wrong.
 */
export async function requestGeminiInteraction(
    options: RequestGeminiInteractionOptions,
): Promise<unknown> {
    const timedSignal = createTimedSignal(options.signal, options.timeoutMs);
    try {
        const response = await (options.fetch ?? fetch)(GEMINI_INTERACTIONS_URL, {
            body: JSON.stringify(options.body),
            headers: {
                "Api-Revision": GEMINI_API_REVISION,
                "Content-Type": "application/json",
                "x-goog-api-key": options.apiKey,
            },
            method: "POST",
            signal: timedSignal.signal,
        });
        const raw = await readBoundedResponseText(response, options.maximumResponseBytes);
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            throw new Error(
                `Gemini ${options.operation} returned invalid JSON (${String(response.status)}).`,
            );
        }
        if (!response.ok) {
            const message = (payload as { error?: { message?: unknown } }).error?.message;
            throw new Error(
                `Gemini ${options.operation} failed (${String(response.status)}): ${typeof message === "string" ? message : response.statusText || "Unknown error"}`,
            );
        }
        return payload;
    } finally {
        timedSignal.dispose();
    }
}
