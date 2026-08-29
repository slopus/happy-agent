# Secrets module learnings

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

There is no user-facing catalog deletion. A daemon feature may retire a managed secret only by
presenting the exact managed kind that owns it. Retirement atomically removes the secret and all
legacy and typed grants, then emits the final safe version through `secret.removed`.

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
