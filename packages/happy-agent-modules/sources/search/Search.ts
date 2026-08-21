import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

export const MAX_SEARCH_AGENT_ID_LENGTH = 256;
export const MAX_SEARCH_QUERY_LENGTH = 20_000;
export const MAX_SEARCH_RESULT_TITLE_LENGTH = 2_000;
/*
 * Search and fetch output must keep an actionable URL intact even when the model
 * output budget is at its minimum of 256 characters.  Keep the URL contract
 * bounded below that budget so the URL can always be followed by a compact
 * continuation or truncation marker.
 */
export const MAX_SEARCH_RESULT_URL_LENGTH = 200;
/** A vendor search answers in prose; the bound keeps one answer from filling a whole context. */
export const MAX_SEARCH_ANSWER_LENGTH = 100_000;
export const MAX_SEARCH_ANSWER_SOURCES = 100;
export const MAX_FETCH_URL_LENGTH = 200;
export const MAX_FETCH_TITLE_LENGTH = 2_000;
export const MAX_FETCH_CONTENT_TYPE_LENGTH = 256;
export const MAX_FETCH_CONTENT_CHARACTERS = 100_000;

export const searchAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SEARCH_AGENT_ID_LENGTH,
});
export const searchTextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SEARCH_QUERY_LENGTH,
});
export const searchProviderSchema = Type.Union([
    Type.Literal("bedrock"),
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("gemini"),
    Type.Literal("grok"),
    Type.Literal("grok-x"),
]);

const searchProviderIdSchema = Type.String({
    minLength: 1,
    maxLength: 256,
});

const searchDomainSchema = Type.String({
    minLength: 1,
    maxLength: 253,
});

/**
 * One provider-routed search request. The ordinary tools expose vendor-shaped argument schemas;
 * this is the normalized host boundary shared by those tools.
 */
export const searchProviderRequestSchema = Type.Object(
    {
        provider: searchProviderSchema,
        query: searchTextSchema,
        providerId: Type.Optional(searchProviderIdSchema),
        allowedDomains: Type.Optional(Type.Array(searchDomainSchema, { maxItems: 100 })),
        blockedDomains: Type.Optional(Type.Array(searchDomainSchema, { maxItems: 100 })),
        latest: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** One page or post the vendor cited while answering. */
export const searchSourceSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: MAX_SEARCH_RESULT_TITLE_LENGTH }),
        url: Type.String({ minLength: 1, maxLength: MAX_SEARCH_RESULT_URL_LENGTH }),
    },
    { additionalProperties: false },
);

/**
 * What a vendor search comes back with: the vendor's own written answer and the sources it
 * cited. A vendor searches, reads, and synthesizes on its own side, so the useful result is the
 * answer rather than a list of links Happy Agent would have to read again.
 */
export const searchAnswerSchema = Type.Object(
    {
        provider: searchProviderSchema,
        query: searchTextSchema,
        answer: Type.String({ minLength: 1, maxLength: MAX_SEARCH_ANSWER_LENGTH }),
        sources: Type.Array(searchSourceSchema, { maxItems: MAX_SEARCH_ANSWER_SOURCES }),
        durationMs: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export const fetchInputSchema = Type.Object(
    {
        url: Type.String({ minLength: 1, maxLength: MAX_FETCH_URL_LENGTH }),
        maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
    },
    { additionalProperties: false },
);

export const fetchResultSchema = Type.Object(
    {
        url: Type.String({ minLength: 1, maxLength: MAX_FETCH_URL_LENGTH }),
        title: Type.Optional(Type.String({ maxLength: MAX_FETCH_TITLE_LENGTH })),
        content: Type.String({
            maxLength: MAX_FETCH_CONTENT_CHARACTERS,
        }),
        contentType: Type.Optional(Type.String({ maxLength: MAX_FETCH_CONTENT_TYPE_LENGTH })),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type SearchProvider = Static<typeof searchProviderSchema>;
export type SearchProviderRequest = Static<typeof searchProviderRequestSchema>;
export type SearchSource = Static<typeof searchSourceSchema>;
export type SearchAnswer = Static<typeof searchAnswerSchema>;
export type FetchInput = Static<typeof fetchInputSchema>;
export type FetchResult = Static<typeof fetchResultSchema>;

/*
 * Context is an extension-bearing runtime object whose enumerable string surface is empty.
 * Keep the schema closed while preserving the real Context type.
 */
export const searchContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);
