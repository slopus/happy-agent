# Projects

Projects are host-owned repository roots exposed to an agent through one small,
provider-neutral facade. The feature never resolves a path, runs Git, opens a
database, or performs filesystem cleanup. Rig supplies those operations through
`ProjectStore`; the feature validates the boundary, provides bounded paging and
detail text, and keeps durable mutation retries safe.

```ts
import { ProjectsFeature } from "@slopus/happy-agent-features";

const projects = new ProjectsFeature({ store: hostProjectStore });
```

## Tools

- `list_projects` lists active or archived projects in bounded cursor pages.
- `get_project` reads one project and its complete, cursor-addressable detail.
- `create_project` registers a repository reference and display name.
- `ensure_project` registers a detected repository exactly once. The store
  decides repository uniqueness inside its transaction and returns
  `{ created: true }` only when it created the row.
- `rename_project` changes a display name.
- `archive_project` records logical archival; host cleanup is independent.
- `get_project_settings` reads bounded recursive JSON settings with detail
  paging.
- `update_project_settings` replaces bounded recursive JSON settings.

All tools are durable and provider-neutral, and all opt out of Auto permission
review. Operation IDs are allocated in each durable tool call's scoped
`AgentKV`; callers outside a tool call must supply one explicitly.

## Public API

Every operation receives `(ctx, agentId, ...)`:

- `listPage`/`list` read bounded cursor pages, with `status` and
  `includeArchived` filters.
- `get` reads a project, and `getPage` reads its bounded detail stream.
- `create` registers a repository and name; `ensure` registers a repository
  exactly once and returns `{ project, created }`.
- `rename` changes the display name, and `archive` records logical archival.
- `readSettings` returns the bounded settings record;
  `readSettingsPage` is the detail-paged model-facing form.
- `updateSettings` replaces settings transactionally.

`formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
`formatProjectForModel`, `formatProjectOperationForModel`,
`formatSettingsForModel`, and `formatSettingsPageForModel` are public so a host
can render the same bounded text used by tools.

## Host boundary

`ProjectStore` owns project rows, settings, receipts, immutable mutation proofs,
transactions, and the outermost commit callback. It must provide bounded
`list`, authoritative `get` and `findByRepositoryRef`, `create`,
transactional `ensure`, `rename`, `archive`, `readSettings`, and
`updateSettings` operations, together with receipt/proof read-write methods. Its
`ensure` operation must enforce a unique repository reference in the same
transaction. The feature checks every result against the requested identity
and fresh authoritative before/after reads.

For every mutation, a receipt is paired with an immutable before/after proof.
Replays validate both records and reconcile the returned project or settings
with current host state; a corrupted or orphaned pair is rejected. The feature
never uses an in-memory lock or repository map, so concurrent ensure calls
converge only through the host transaction.

Every changed mutation is represented by one frozen event:
`project_created`, `project_renamed`, `project_archived`, or
`project_settings_updated`. Transactional and post-commit listeners receive the
same event object. Post-commit listener failures are contained and optionally
reported through `onPostCommitError`.

Settings are finite recursive JSON. Every level is bounded by explicit
depth/string/item/property limits, and the encoded UTF-8 representation is
bounded before it crosses the store boundary. Authorization defaults to
same-owner access only; a host policy may grant cross-agent reads or actions.
