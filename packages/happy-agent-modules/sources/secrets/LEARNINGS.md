# Secrets module learnings

## The catalog is global; attachments are scoped

Secrets registered for Happy Agent belong to one installation-wide catalog. Agent identities do
not partition what references are discoverable; they identify the command scopes to which global
references are attached. Agent tools and the default command host therefore use
`GLOBAL_SECRET_OWNER_ID` for catalog operations and use the current agent ID only as `scopeRef`.

## Attachment changes are permission decisions

Attaching a secret grants a scope access to a credential in later host operations, and detaching
revokes that access. Both model-facing tools therefore always require Auto review and describe the
exact secret reference and scope being changed. The catalog mutation itself remains sandboxed and
does not receive a Full-access override; metadata-only listing and reference reads remain
unreviewed.

## Model-created secrets use reviewed host-side dotenv imports

Secret values do not belong in model-visible tool arguments or results. The `create_secret` and
`update_secret` tools therefore accept an absolute `.env` path and read it only after Auto review.
That exact file read temporarily receives Full access because it crosses the local shell sandbox;
the resulting catalog mutation neither attaches the secret nor grants later commands elevation.
Update replaces the complete environment bundle so values removed from the source file do not
linger. Both tools are non-durable because the external file could change before a restarted call
was replayed.
