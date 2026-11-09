# Secrets module learnings

## Catalog tools always show complete safe metadata

Large catalog pages used to switch silently to IDs only once the rendered text exceeded 12,000
characters, hiding the descriptions and environment-variable names needed to select a secret.
Catalog tools now render every returned entry's full description, variable names, and applicable
availability or ownership status, regardless of output length. Explicit page limits and continuation
cursors remain unchanged; output size must not shrink a page or replace metadata with IDs. The same
formatter serves listing, reference, creation, update, and attachment results. Values remain absent
from all results and model-facing text.

## Git names are ordinary user secrets

The catalog used to reserve `github` and `project-git` even though it no longer creates either
managed credential. Both names now follow the same registration, attachment, and command
selection rules as every other user secret. Nothing imports the host's GitHub login into the
secret catalog.

A new migration retires historical managed rows under those two names together with their typed
and legacy grants. It selects by name and a non-null managed kind, so ordinary user-created
secrets keep their values and grants. The storage migration is atomic and never reads a host
credential store or deserializes secret values.

## The catalog is global; direct grants are typed

Secrets registered for Happy Agent belong to one installation-wide catalog. Agent identities do
not partition what references are discoverable. An immutable direct grant names a project,
workspace, or exact agent. Project grants apply to every workspace in that project, workspace
grants stay with that exact workspace, and agent grants do not flow to descendants. The compute
configuration carries the agent's durable project and workspace identities so command resolution
can take the union without reaching into another module's storage.

Public secret records have installation-wide names of 2–32 characters: they start with a lowercase
letter and otherwise accept lowercase letters, digits, underscores, and dashes. Generated names
remain CUID2s. Direct grants retain their own CUID2 identities. Every observable secret change
mints a durable UUIDv7 version and updates its timestamp, including a value-only rotation whose
safe variable-name list did not change. Events carry safe before/after metadata or an immutable
grant and never carry the stored environment. Legacy records whose IDs cannot be represented by
the public contract stay outside the catalog during the storage upgrade.

## Deletion is for people, and it takes every grant with it

A person deletes a user-created secret through `deleteCatalogSecret`, which backs
`DELETE /v0/secrets/:secretId`. Deletion is version-checked like an update and removes the secret
together with every typed and legacy grant in one change, so no agent can select a secret that is
gone. The secret row is deleted first, conditioned on the expected version; grants are removed only
when that row matched, so a lost race changes nothing even if a caller's outer transaction catches
the conflict. A managed secret is refused because the feature that owns it is responsible for it.

Steve chose humans only: there is deliberately no `delete_secret` agent tool. Detaching remains the
agent-facing way to revoke access.

A daemon feature may retire a managed secret only by presenting the exact managed kind that owns
it. Retirement shares the same row-then-grants removal. Both paths emit the final safe version
through `secret_api_removed`, which the API publishes as `secret.removed`.

## Attachment changes are permission decisions

Attaching a secret grants a target access to a credential in later host operations, and detaching
revokes that direct access. Both model-facing tools therefore always require Auto review and
describe the exact secret reference and agent being changed. The catalog mutation itself remains
sandboxed and does not receive a Full-access override; metadata-only listing and reference reads
remain unreviewed. Authenticated HTTP mutations are direct client actions and do not enter the
agent's Auto reviewer.

## Values enter through explicit trusted write boundaries

The `create_secret` and `update_secret` tools accept exactly one value source: raw `environment`
arguments, which remain in the durable transcript, or an absolute `.env` path. Both mutations
require Auto review. An inline mutation stays in the current sandbox; only the reviewed host-file
read receives temporary Full access. Neither source is returned in the tool result. Update replaces
the complete environment bundle so values removed from the source do not linger. Both tools remain
non-durable because one supported source is an external file that could change before replay.

The authenticated HTTP API is a different trusted input boundary: create and update requests may
carry raw environment values directly, including values loaded by a client from dotenv. Those
values are write-only. Responses, conflict bodies, catalog filters, attachment objects, bootstrap
state, and mutation events contain only safe metadata.

## A bot's allowlist bounds every agent-facing path and every command

A bot's owner may allow its agents only certain secrets. The allowlist is enforced here, not in
the prompt: `list_secrets` and `reference_secret` show only allowed secrets, `attach_secret`,
`detach_secret`, and `update_secret` refuse any other, and `create_secret` is refused under any
allowlist because a new secret is outside it. Command resolution is the boundary that matters,
since a command also inherits project and workspace attachments: the default selection drops what
the bot does not allow, and an explicit selection outside the allowlist is refused, wherever the
secret was attached. The owner's API catalog is never narrowed by a bot.
