# Tool discovery learnings

## Tool owners declare discovery policy directly

Do not add a runtime metadata wrapper, a module-name policy registry, or a fallback that silently
classifies future modules. Each executable tool definition sets `defer` itself and owns its concise
capability and BM25 keywords. This keeps fixed tool arrays correct when a module is installed on
its own and prevents sibling tools from receiving identical broad search terms.

Compute and structured user-input tools are deliberately eager. Most feature tools are deferred.
Provider-owned discovery tools do not set `defer`; their native server descriptor owns the call.

## Native discovery selection is closed

Select a discovery descriptor only for an exact provider/model route known to support it. Unknown
models and providers receive no discovery tool, causing Happy Providers to expose deferred tools
eagerly instead of hiding capabilities behind an unproven search surface.

Bedrock Runtime uses AWS's documented hosted regex descriptor because its SDK route speaks the
InvokeModel API that supports server-side tool search. Do not substitute Anthropic's BM25
descriptor without Bedrock-specific evidence. The Anthropic adapter appends `searchKeywords` to
every deferred tool's hosted search description, so owner-written synonyms remain searchable.
Bedrock Mantle stays eager because hosted search support is not established for that transport.
