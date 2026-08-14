import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    fetchInputSchema,
    fetchResultSchema,
    searchAgentIdSchema,
    searchPageSchema,
    searchQuerySchema,
} from "./Search.js";

/*
 * Context is an extension-bearing runtime object whose enumerable string surface is empty.
 * Keep the schema closed while preserving the real host-facing Context type.
 */
export const searchContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

/** Runtime shape of the host-injected search boundary. */
export const searchBackendSchema = Type.Object(
    {
        search: Type.Function(
            [searchContextSchema, searchAgentIdSchema, searchQuerySchema],
            Type.Promise(searchPageSchema),
        ),
        fetch: Type.Function(
            [searchContextSchema, searchAgentIdSchema, fetchInputSchema],
            Type.Promise(fetchResultSchema),
        ),
    },
    { additionalProperties: false },
);

/**
 * Host-owned search/fetch implementation; it owns network clients, indexes, and timeouts.
 * Search cursors are zero-based offsets, and a non-terminal page must advance by its visible
 * result count.
 */
export type SearchBackend = Static<typeof searchBackendSchema>;
