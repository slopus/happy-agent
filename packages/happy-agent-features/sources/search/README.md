# Search

Web search and page fetch, over a backend the host supplies. The feature does not talk to any
search engine or the network itself; it validates and bounds what goes out to the backend and what
comes back from it, and it is the same two tools for every model rather than a vendor's own search
surface.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SearchFeature } from "@slopus/happy-agent-features";

const search = new SearchFeature({
    backend: hostSearchBackend,
    maxResults: 10,
    maxCharacters: 40_000,
    maxOutputCharacters: 12_000,
});
const agent = await Agent.create(ctx, { ...options, features: [search] });
```

`backend` is the only required option; it must satisfy `SearchBackend` (below). `maxResults` caps
results per page (1–50, default 10), `maxCharacters` caps fetched content before truncation
(1,000–100,000, default 40,000), and `maxOutputCharacters` caps what the model actually sees per
tool call (256–100,000, default 12,000). One `SearchFeature` instance can serve every agent in a
collection; `agentId` is threaded through to the backend on each call.

## Tools

- **`web_search`** — searches the backend with `{ query, limit?, cursor? }` and returns a
  `SearchPage`. `query` is trimmed and must be non-empty (max 20,000 characters). `cursor` is a
  zero-based, bounded offset into the result set (0 to 1,000,000); omit it for the first page.
  `limit` (1–50) is clamped to the feature's `maxResults` and to however many result URLs can fit
  in `maxOutputCharacters`, so the backend is never asked for more than the model could be shown.
  The model sees one URL per line, opportunistically followed by ` — title` when it still fits the
  output budget, and a trailing `next_cursor=<n>` line when there is more to page through; an empty
  page reads `No search results.`
- **`web_fetch`** — fetches one URL through the backend with `{ url, maxCharacters? }` and returns
  a `FetchResult`. `url` must be a valid `http`/`https` URL (max 200 characters after
  normalization); anything else is rejected before the backend is called. `maxCharacters`
  (1,000–100,000) is clamped to the feature's `maxCharacters`. The model sees the URL first, then
  the title and content as far as they fit `maxOutputCharacters`, with a `[Content truncated.]`
  marker when the model-visible text or the underlying content was cut.

Both tools are `durable: true` and set `shouldReviewInAutoMode: () => false`, so they run without
an Auto-mode review — the feature treats outbound search and fetch as read-only network calls, not
actions on the sandboxed machine. Neither tool touches the filesystem or a compute; everything they
do goes through the injected backend. The URL is always the identity that is kept intact: formatting
never truncates or drops a URL to make room for a title, snippet, or continuation cursor, so every
row the model is shown remains one it can act on or follow.

## External functions

- **`search.search(ctx, agentId, query: SearchQuery): Promise<SearchPage>`** — normalizes and
  bounds `query`, calls `backend.search(ctx, agentId, normalized)`, and validates the returned page
  before returning it. Validation requires the page to echo the same (trimmed) `query`, to return
  no more results than requested, to use canonical `http`/`https` URLs with no duplicate URLs or
  ids, and — when `nextCursor` is present — to advance the cursor by exactly the number of visible
  results (`requested + results.length`), never past a page that returned nothing. It also confirms
  the whole page can be rendered for the model within the format's rules before returning, so a
  page whose identities cannot all be shown is rejected outright rather than silently trimmed.
- **`search.fetch(ctx, agentId, input: FetchInput): Promise<FetchResult>`** — normalizes and
  lower-bounds `input.url` (protocol, canonical form, length), calls
  `backend.fetch(ctx, agentId, normalized)`, and requires the backend to return content for that
  same normalized URL. If the backend's content exceeds the requested character bound, it is
  sliced and `truncated` is forced to `true`.
- **`search.formatSearchForModel(page: SearchPage): string`** and
  **`search.formatFetchForModel(result: FetchResult): string`** — the exact formatting the tools
  use to turn a validated page or fetch result into model-visible text, exposed so a host can
  render the same output outside a tool call. Both throw if given a page or result that fails the
  corresponding schema.
- **`search.tools(ctx, scope): readonly AnyAgentTool[]`** — returns `[webSearchTool(this,
  scope.agent.id), webFetchTool(this, scope.agent.id)]`; this is how `Agent.create` wires the two
  tools above into a specific agent's tool set. `webSearchTool` and `webFetchTool` are exported
  directly as well, for a host assembling tools outside the standard feature path.

None of these functions emit events or take listeners; the feature has no async or background work
of its own; every call resolves or rejects within the single `search`/`fetch` round trip.

## Storage

The feature persists nothing itself. It is stateless between calls: `SearchFeature` holds only its
constructor-time bounds (`maxResults`, `maxCharacters`, `maxOutputCharacters`) and a reference to
the host-supplied `backend`, and every `search`/`fetch` call is answered fresh from that backend.
Any durability — caching search results, storing fetched pages, rate-limiting a client, keeping
indexes — is entirely the concern of the host's `SearchBackend` implementation, which the feature
never inspects beyond its `search` and `fetch` function shapes (`searchBackendSchema` in
`SearchBackend.ts`). Cursors are likewise not stored: a cursor is just the offset the backend
already returned, and the model must submit it back verbatim to page forward.
