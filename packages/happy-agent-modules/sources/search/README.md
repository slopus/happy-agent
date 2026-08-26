# Search

Web search and page fetch, run by the module itself. There is no injected backend and no host
boundary: the module owns the routing, the vendor call, and the fetch. Every model receives the
same fixed base tool array, with Gemini web search added only when a Gemini API key is configured.
The vendor names select which account the search runs on; they do not lift a provider's server tool
into Agent Base.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { ConfigModule, SearchModule } from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const search = new SearchModule(config);
const agent = await Agent.create(ctx, { ...options, modules: [search] });
```

The module takes only the configuration module, and asks it for everything a search needs: the
accounts (`providers`), the catalog each vendor searches with (`models`), the model a Bedrock
account serves its hosted index from (`bedrockSearchModels`), and the Gemini key
(`geminiApiKey`) — Gemini is not one of the accounts a chat runs on, so it authenticates with a key
of its own. Agent tools take the actual current provider from their agent scope. The matching
vendor tool identifies itself as the preferred web search, and omitting `provider_id` routes the
call through that current account. Direct module callers that have no agent scope retain the first
configured model as their default.

The bounds are the module's own constants rather than settings: `MAX_SEARCH_FETCH_CHARACTERS`
(40,000) is how much of a fetched page is kept before truncation, and `MAX_SEARCH_OUTPUT_CHARACTERS`
(12,000) is how much of an answer or a page one tool call may show the model. Both are exported so a
caller can render or reason about the same limits. One `SearchModule` instance serves every agent in
a collection; `agentId` is threaded through on each call.

## Tools

The fixed base array matches Happy Agent:

- **`web_fetch`**
- **`claude_web_search`**
- **`codex_web_search`**
- **`bedrock_web_search`**
- **`grok_web_search`**
- **`grok_x_search`**

**`gemini_web_search`** is added to that array only when a Gemini API key resolves to a usable
value, from `[gemini] api_key` in the user `happy.toml` or from `GEMINI_API_KEY`.
It is absent when the key is missing or blank, so a model cannot select a tool that is guaranteed
to fail authentication. The available tools are shared by Claude, Codex, Grok, Bedrock, and future
providers. A vendor search spends one bounded call on that vendor's own search — Codex's
`web_search`, Claude's `WebSearch`, Bedrock's hosted index, Grok's `web_search` and `x_search`, and
Gemini's grounding over Google's HTTP API — on an account the person already configured.
The fixed array remains available to every model, but exactly one ordinary web-search description
is marked preferred when the current provider has a matching search. Other vendor searches remain
available for an explicit request or fallback.

A vendor search is not paginated. Each search returns a bounded `SearchAnswer` (`provider`, `query`,
`answer`, `sources`, `durationMs`). The model sees the vendor's answer text first, then a bounded
`Sources:` block of one URL per line, opportunistically followed by ` — title` when it fits.

- **`web_fetch`** — fetches one URL with `{ url, maxCharacters? }` and returns a `FetchResult`.
  `url` must be a valid `http`/`https` address (max 200 characters after normalization), and
  credentials in the URL are refused so a fetch cannot carry a secret outward. Where a fetch may
  go is a permission decision, not a hardcoded list: the tool requests Auto review like every
  other search tool. HTML comes back as markdown, other text as it arrived, and bytes that are not text are
  reported rather than decoded. A redirect off the site is reported so following it stays a
  deliberate second call. `maxCharacters` (1,000–100,000) is clamped to
  `MAX_SEARCH_FETCH_CHARACTERS`. The model sees the URL first, then the title and content as far as
  they fit `MAX_SEARCH_OUTPUT_CHARACTERS`, with a `[Content truncated.]` marker when the
  model-visible text or the underlying content was cut.

All tools are `durable: false` because retrying an interrupted vendor call could repeat billed or
externally observable work. They require Auto or Full access and request Auto review because the
search and the fetch reach the network outside the local shell sandbox. The URL is always the
identity that is kept intact: formatting never truncates or drops a URL to make room for a title or
answer text, so every row the model is shown remains one it can act on or follow. Answer text, by
contrast, is prose and may be cut with an `[Answer truncated.]` marker to keep the sources visible.

## External functions

- **`search.providerSearch(ctx, agentId, request, currentProviderId?): Promise<SearchAnswer>`** — normalizes a
  vendor-routed request, runs that vendor's search, and validates the answer: it must echo the same
  vendor and (trimmed) query, report a finite non-negative duration, and cite canonical
  `http`/`https` sources with no duplicate URLs. It also confirms the answer can be rendered within
  `MAX_SEARCH_OUTPUT_CHARACTERS` before returning. Agent tools pass their current provider ID;
  direct callers may pass one or use the configured default. A request that both allows and blocks
  domains, or that names an account the person has not configured, is rejected before any vendor
  is called.
- **`search.fetch(ctx, agentId, input: FetchInput): Promise<FetchResult>`** — normalizes and
  lower-bounds `input.url` (protocol, canonical form, length), fetches the page,
  and returns it as text. If the content exceeds the requested character bound, it is sliced and
  `truncated` is forced to `true`.
- **`search.formatSearchAnswerForModel(answer: SearchAnswer): string`** and
  **`search.formatFetchForModel(result: FetchResult): string`** — the exact formatting the tools
  use to turn a validated answer or fetch result into model-visible text, exposed so a host can
  render the same output outside a tool call. Both throw if given a value that fails its schema.
- **`search.tools(ctx, scope)`** — returns the fixed base array above for every provider and adds
  `gemini_web_search` when a Gemini API key is configured.

None of these functions emit events or take listeners; every call resolves or rejects within the
single search or fetch it performs.

## Storage

The module persists nothing. It is stateless between calls: `SearchModule` holds only the
configuration module, resolving the Gemini key when tools are assembled and resolving the routes
and key again each time a search runs. Every call is answered fresh from the vendor. Search
results, fetched pages, and rate limits are not cached anywhere.
