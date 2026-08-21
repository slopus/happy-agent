import type { SearchAnswer, SearchProviderRequest, SearchSource } from "../Search.js";
import type { Context } from "@steve.kite/stdlib";

import { boundedSources } from "./boundedSources.js";
import { createTimedSignal } from "../../impl/createTimedSignal.js";
import type { VendorSearchContext } from "./VendorSearchContext.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_SEARCH_MODEL = "gemini-3.5-flash";
const GEMINI_SEARCH_TIMEOUT_MS = 30_000;
const MAX_GEMINI_RESPONSE_BYTES = 2_000_000;

interface GeminiTextBlock {
    readonly annotations?: readonly {
        readonly title?: string;
        readonly type?: string;
        readonly url?: string;
    }[];
    readonly text?: string;
    readonly type?: string;
}

interface GeminiInteractionResponse {
    readonly steps?: readonly {
        readonly content?: readonly GeminiTextBlock[];
        readonly type?: string;
    }[];
}

/**
 * Gemini grounding, over Google's own HTTP interface.
 *
 * Gemini is not one of the chat providers Happy Agent runs conversations on, so this search does not go
 * through a configured account. It needs a Gemini API key and nothing else.
 */
export async function geminiWebSearch(
    _ctx: Context,
    search: VendorSearchContext,
    request: SearchProviderRequest,
): Promise<SearchAnswer> {
    const apiKey = search.geminiApiKey;
    if (apiKey === undefined) {
        throw new Error(
            "Gemini search needs a Gemini API key. Set GEMINI_API_KEY to use gemini_web_search.",
        );
    }
    const startedAt = performance.now();
    const payload = await requestGeminiInteraction(apiKey, {
        input: geminiPrompt(request),
        model: GEMINI_SEARCH_MODEL,
        tools: [{ type: "google_search" }],
    });
    const durationMs = performance.now() - startedAt;
    const interaction =
        typeof payload === "object" && payload !== null
            ? (payload as GeminiInteractionResponse)
            : {};
    const sources = new Map<string, SearchSource>();
    const text: string[] = [];
    for (const step of interaction.steps ?? []) {
        if (step.type !== "model_output") continue;
        for (const block of step.content ?? []) {
            if (block.type !== "text") continue;
            if (block.text?.trim()) text.push(block.text.trim());
            for (const annotation of block.annotations ?? []) {
                if (annotation.type !== "url_citation" || !annotation.url) continue;
                sources.set(annotation.url, {
                    title: annotation.title?.trim() || annotation.url,
                    url: annotation.url,
                });
            }
        }
    }
    if (text.length === 0) {
        throw new Error(`Gemini searched for "${request.query}" but wrote no answer.`);
    }
    return {
        provider: "gemini",
        query: request.query,
        answer: text.join("\n\n"),
        sources: boundedSources([...sources.values()]),
        durationMs,
    };
}

function geminiPrompt(request: SearchProviderRequest): string {
    return [
        `Search the web for: ${request.query}`,
        ...(request.allowedDomains === undefined || request.allowedDomains.length === 0
            ? []
            : [`Only use sources from these domains: ${request.allowedDomains.join(", ")}.`]),
        ...(request.blockedDomains === undefined || request.blockedDomains.length === 0
            ? []
            : [`Do not use sources from these domains: ${request.blockedDomains.join(", ")}.`]),
        "Return a concise synthesis supported by source citations.",
    ].join("\n");
}

async function requestGeminiInteraction(apiKey: string, body: unknown): Promise<unknown> {
    const timedSignal = createTimedSignal(undefined, GEMINI_SEARCH_TIMEOUT_MS);
    try {
        const response = await fetch(GEMINI_INTERACTIONS_URL, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            method: "POST",
            signal: timedSignal.signal,
        });
        const raw = await readBoundedResponseText(response, MAX_GEMINI_RESPONSE_BYTES);
        let payload: unknown;
        try {
            payload = JSON.parse(raw);
        } catch {
            throw new Error(
                `Gemini web search returned an unreadable response (${String(response.status)}).`,
            );
        }
        if (!response.ok) {
            const message = (payload as { error?: { message?: unknown } }).error?.message;
            throw new Error(
                `Gemini web search failed (${String(response.status)}): ${
                    typeof message === "string" ? message : response.statusText || "Unknown error"
                }`,
            );
        }
        return payload;
    } finally {
        timedSignal.dispose();
    }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error("The Gemini response is too large to read.");
    }
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) {
                await reader.cancel();
                throw new Error("The Gemini response is too large to read.");
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
}
