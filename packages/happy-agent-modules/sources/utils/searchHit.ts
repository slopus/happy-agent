import type { SearchResult, SearchType } from "@slopus/happy-agent-client";

/**
 * One search result as a provider returns it, before fusion gives it a `rank`. Providers live in
 * the modules that own what they search; this shared shape is all they agree on.
 */
export type SearchHit<Type extends SearchType = SearchType> = Type extends SearchType
    ? Omit<Extract<SearchResult, { type: Type }>, "rank">
    : never;
