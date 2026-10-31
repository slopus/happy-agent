# Task icons

The daemon bundles the catalog and all 2,000 128px WebP images. A top-level task whose owner
enabled rich tasks searches the catalog and selects its own title and icon with ordinary tools.
The task's ordinary model chooses among search results.

```text
task agent → search_task_icons → BM25 → at most ten candidates
           → set_task_title_icon → Tasks canonical mutation → task.updated
client     → task.icon {type, slug, hash} → GET /v0/task-icons/:slug?v=:hash
                                            → bundled WebP + ETag
```

`TaskIconsModule(tasks, richTasks, durableFunctions)` owns the assets and tools. Eligibility is checked when tools
are offered and when called. Setters accept no target ID and Tasks protects each field chosen
by a person. The setter commits a Durable Functions intent with the tool call. Its executor runs
outside the calling turn, rechecks the setting and human choices, and writes through Tasks. This
is necessary because a tool cannot mutate its own agent metadata from inside that agent's turn.
The tool reports that the accepted change applies when the turn ends. A restart resumes its intent;
a person choosing a field or disabling rich tasks cancels it without an error.

Search uses the repository's BM25 implementation over labels, aliases, tags, category,
descriptions, and slugs. Equal scores use slug order; unmatched queries return no candidates.
The frontend needs no catalog: known slugs receive an optional digest on projection, while
legacy unknown slugs retain their readable shape and use the client's fallback.

The raw image route uses ordinary daemon authentication. A matching version is immutable;
unversioned requests revalidate, and an incorrect version returns 404.
