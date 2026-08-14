import { Type, type Static } from "@sinclair/typebox";

export const MAX_SEARCH_AGENT_ID_LENGTH = 256;
export const MAX_SEARCH_QUERY_LENGTH = 20_000;
/** The largest zero-based result offset accepted by the search boundary. */
export const MAX_SEARCH_CURSOR = 1_000_000;
export const MAX_SEARCH_RESULT_ID_LENGTH = 128;
export const MAX_SEARCH_RESULT_TITLE_LENGTH = 2_000;
/*
 * Search and fetch output must keep an actionable URL intact even when the model
 * output budget is at its minimum of 256 characters.  Keep the URL contract
 * bounded below that budget so the URL can always be followed by a compact
 * continuation or truncation marker.
 */
export const MAX_SEARCH_RESULT_URL_LENGTH = 200;
export const MAX_SEARCH_RESULT_SNIPPET_LENGTH = 10_000;
export const MAX_SEARCH_RESULT_SOURCE_LENGTH = 512;
export const MAX_SEARCH_RESULT_PUBLISHED_AT_LENGTH = 128;
export const MAX_SEARCH_RESULTS_PER_PAGE = 50;
export const MAX_FETCH_URL_LENGTH = 200;
export const MAX_FETCH_TITLE_LENGTH = 2_000;
export const MAX_FETCH_CONTENT_TYPE_LENGTH = 256;
export const MAX_FETCH_CONTENT_CHARACTERS = 100_000;

export const searchAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SEARCH_AGENT_ID_LENGTH,
});
const searchTextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SEARCH_QUERY_LENGTH,
});
/** A cursor is a bounded, zero-based offset into the result set. */
export const searchCursorSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_SEARCH_CURSOR,
});

export const searchResultSchema = Type.Object(
    {
        id: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_SEARCH_RESULT_ID_LENGTH,
            }),
        ),
        title: Type.String({
            minLength: 1,
            maxLength: MAX_SEARCH_RESULT_TITLE_LENGTH,
        }),
        url: Type.String({
            minLength: 1,
            maxLength: MAX_SEARCH_RESULT_URL_LENGTH,
        }),
        snippet: Type.Optional(Type.String({ maxLength: MAX_SEARCH_RESULT_SNIPPET_LENGTH })),
        source: Type.Optional(Type.String({ maxLength: MAX_SEARCH_RESULT_SOURCE_LENGTH })),
        publishedAt: Type.Optional(
            Type.String({ maxLength: MAX_SEARCH_RESULT_PUBLISHED_AT_LENGTH }),
        ),
        score: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
);

export const searchQuerySchema = Type.Object(
    {
        query: searchTextSchema,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        cursor: Type.Optional(searchCursorSchema),
    },
    { additionalProperties: false },
);

export const searchPageSchema = Type.Object(
    {
        query: searchTextSchema,
        results: Type.Array(searchResultSchema, {
            maxItems: MAX_SEARCH_RESULTS_PER_PAGE,
        }),
        nextCursor: Type.Optional(searchCursorSchema),
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

export type SearchResult = Static<typeof searchResultSchema>;
export type SearchQuery = Static<typeof searchQuerySchema>;
export type SearchPage = Static<typeof searchPageSchema>;
export type FetchInput = Static<typeof fetchInputSchema>;
export type FetchResult = Static<typeof fetchResultSchema>;
