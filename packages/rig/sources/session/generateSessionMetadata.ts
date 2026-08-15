import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Model, Provider } from "@slopus/rig-execution";
import { providerModelFamily } from "@slopus/happy-providers";
import { toLocalDate } from "./toLocalDate.js";
import { ABORTED_BY_SIGNAL, raceWithAbort } from "../utils/raceWithAbort.js";
import { withLifetime, type Context as RuntimeContext } from "@steve.kite/stdlib";

const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 6;
const MAX_RECAP_CHARS = 600;
const MAX_RECAP_SENTENCES = 2;

/**
 * Naming a chat is a small writing task, not a coding turn, so it is asked in the shape models
 * answer most reliably: plain text between tags. A schema would be enforced by the vendor for some
 * providers and simulated with a retry loop for others, and the loop was what left chats unnamed.
 */
const METADATA_PROMPT = `You write short metadata for a saved chat. Reply with exactly these two tags and nothing else:

<title>2 to 6 words naming what the chat is about</title>
<recap>One or two sentences: the user's goal and the useful outcome or current state.</recap>

Rules:
- keep the title under 80 characters and the recap under 600 characters
- keep the current title exactly unless the conversation clearly makes it misleading
- use only the supplied conversation; do not guess at work you cannot see`;

export const SESSION_METADATA_SCHEMA = Type.Object(
    {
        title: Type.String(),
        recap: Type.String(),
    },
    { additionalProperties: false },
);

export type GeneratedSessionMetadata = Static<typeof SESSION_METADATA_SCHEMA>;

export async function generateSessionMetadata(
    ctx: RuntimeContext,
    options: {
        currentTitle?: string;
        /** Model the session itself is running, which decides what may name it. */
        modelId: string;
        now?: () => number;
        provider: Provider;
        sessionId: string;
        signal?: AbortSignal;
        startDate?: string;
        transcript: string;
    },
): Promise<GeneratedSessionMetadata> {
    const now = options.now ?? Date.now;
    const model = selectMetadataModel(options.provider, options.modelId);
    const operationCtx = options.signal === undefined ? ctx : withLifetime(ctx, options.signal);
    const answered = options.provider.rawQuery(operationCtx, {
        instructions: METADATA_PROMPT,
        model,
        prompt: [
            `Current title: ${options.currentTitle ?? "(untitled)"}`,
            "",
            "Visible conversation:",
            options.transcript,
        ].join("\n"),
        // Naming a chat is its own one-shot conversation, not a turn of the session's.
        sessionId: `${options.sessionId}:title`,
        startDate: options.startDate ?? toLocalDate(now()),
    });
    const result = await raceWithAbort(answered, options.signal);
    if (result === ABORTED_BY_SIGNAL) {
        throw new Error("Session metadata generation was cancelled.");
    }
    return parseSessionMetadata(result);
}

/**
 * Reads the title and recap out of whatever the model said.
 *
 * A model that adds a greeting, a code fence, or a closing remark has still answered the question,
 * so only the tagged text is read and the rest is ignored. Text that is merely too long is
 * shortened rather than rejected: a slightly long title beats no title at all.
 */
export function parseSessionMetadata(text: string): GeneratedSessionMetadata {
    const title = normalizeLine(readTag(text, "title") ?? "");
    const recap = normalizeLine(readTag(text, "recap") ?? "");
    const value = { recap: shortenRecap(recap), title: shortenTitle(title) };
    if (!Value.Check(SESSION_METADATA_SCHEMA, value)) {
        throw new Error("Session metadata must contain only string title and recap fields.");
    }
    if (value.title.length === 0 || value.recap.length === 0) {
        throw new Error("Session metadata must contain a title and a recap.");
    }
    return value;
}

function readTag(text: string, tag: string): string | undefined {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu").exec(text);
    return match?.[1];
}

function shortenTitle(title: string): string {
    const words = title.split(/\s+/u).filter(Boolean).slice(0, MAX_TITLE_WORDS);
    const shortened = words.join(" ");
    return shortened.length <= MAX_TITLE_CHARS
        ? shortened
        : `${shortened.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

function shortenRecap(recap: string): string {
    const sentences = recap.split(/(?<=[.!?])\s+/u).filter(Boolean);
    const shortened = sentences.slice(0, MAX_RECAP_SENTENCES).join(" ");
    return shortened.length <= MAX_RECAP_CHARS
        ? shortened
        : `${shortened.slice(0, MAX_RECAP_CHARS - 1).trimEnd()}…`;
}

function normalizeLine(value: string): string {
    return value
        .replace(/[\r\n\t]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

/** Inexpensive models worth naming a chat with, one per family. */
const ECONOMICAL_MODEL_IDS = [
    "anthropic/sonnet-5",
    "openai/gpt-5.6-sol",
    "xai/grok-composer-2.5-fast",
];

/**
 * Picks what writes the title, starting from the model the session is already running.
 *
 * Writing two sentences deserves the cheapest model available, but not at the cost of leaving the
 * session's own family: a provider cannot serve a model from another family, so reaching for one
 * fails outright. The session's model is therefore both the starting point and the fallback.
 */
function selectMetadataModel(provider: Provider, sessionModelId: string): Model {
    const sessionModel = provider.models.find((model) => model.id === sessionModelId);
    if (sessionModel === undefined) {
        throw new Error(
            `Model '${sessionModelId}' is unavailable on '${provider.id}' for session metadata.`,
        );
    }
    const family = providerModelFamily(sessionModelId);
    const economical = provider.models.find(
        (model) =>
            ECONOMICAL_MODEL_IDS.includes(model.id) && providerModelFamily(model.id) === family,
    );
    return economical ?? sessionModel;
}
