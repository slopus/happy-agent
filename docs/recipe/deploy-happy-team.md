# Create and deploy a Happy team

Use this recipe when the user wants a shared Happy Agent server for a named team. The outcome is a
WorkOS-backed Happy team, a working team-mode deployment, and a verified local connection. Ask for
invitation recipients only after the deployment and connection work.

Read [Happy teams](../happy-teams.md) and [Team deployment mode](../team-mode.md) first. Execute the
routine work within the user's authorized task; ask only for missing material choices, access, or
interactive sign-in. This recipe does not authorize buying infrastructure, exposing an unrelated
machine, transferring provider credentials, or sending unsolicited invitations.

When adding a connection to an already deployed team, reuse its verified team ID and endpoint.
Verify the running service as described in step 4, then follow step 5, including the current
member's profile and Desktop readiness checks. Creating a team or redeploying its server is not
required to add a connection.

## 1. Confirm the user's account

Use an active admin bot on the user's local standalone installation for this workflow. First call
`get_happy_workos_state` with `{}`. Determine login status from the tool result, not by asking the
user whether they are signed in:

- A successful result with `workos_user_id` and `workos_client_id` confirms authentication. Save
  those exact values for deployment and continue without requesting login confirmation or another
  sign-in. Do not guess IDs or substitute the user's email for their WorkOS user ID.
- If the result reports missing or invalid authentication, ask the user to open
  **Settings → Account → Join Happy Social** and complete the interactive sign-in. Call
  `get_happy_workos_state` again afterward to verify success before making team changes.
- A permission or connectivity error does not mean the user is logged out. Resolve or report that
  specific blocker rather than prescribing a new login.

The account must also have a bound email address. Any email address the user can access works,
including a personal address; no company domain is required. Complete any requested email
verification in the account flow. The state lookup verifies authentication but does not return
email-binding status. Never ask the user to paste a password, access token, or refresh token into
the conversation.

## 2. Choose the name and prepare the endpoint

Reuse the exact team name and deployment destination the user supplied. If either is missing, ask
for it. Ask as well for a second machine that can reach the destination, to host the team's
default runner (see step 4); continue without one only if the user declines. Choose a local connection name and an unused connection ID as well. Do not use the example
names, IDs, or addresses in this recipe as real values.

Call `list_happy_teams` with `{}` and follow `next_offset` using `{ "offset": NEXT_OFFSET }` until
it is null. If the requested team already exists, establish whether the user wants to configure
that team or create a separate one; do not silently create duplicates.

Use Tailcat for this recipe: the local connection tools take its case-sensitive address and API
port. On the authorized host, follow sections 1 and 2 of [Team deployment mode](../team-mode.md)
to install the released binary, prepare the service account and provider access, and bootstrap the
Tailcat identity. Keep the service's data and identity on persistent storage.

Record the exact `tailcat://ADDRESS:PORT` endpoint from the host's live Tailcat address and port
files. Treat the address as private discovery information and never transfer its private identity
key. If the host already has a stable Tailcat endpoint, reuse it after verifying its ownership and
configuration.

This minimal bootstrap is necessary because `create_happy_team` requires an endpoint; it cannot
create a name-only team. The next step creates the organization, and only then is its team-mode
deployment configured. Do not publish a made-up endpoint to avoid this prerequisite.

## 3. Create the named team

Call `create_happy_team` with the chosen name and the exact endpoint:

```json
{
    "name": "Acme Engineering",
    "endpoint": "tailcat://REPLACE_WITH_EXACT_TAILCAT_ADDRESS:24779"
}
```

Save the returned team ID, name, and endpoint. The connected user becomes the organization's
administrator. This operation registers the team; it does not deploy the server.

If creation reports that the organization was created but endpoint registration failed, keep the
team ID from the error and finish with `update_happy_team`:

```json
{
    "team_id": "org_REPLACE_WITH_CREATED_TEAM_ID",
    "endpoint": "tailcat://REPLACE_WITH_EXACT_TAILCAT_ADDRESS:24779"
}
```

Do not repeat creation after a partial or ambiguous success. Inspect the user's teams first.

## 4. Deploy in team mode and check the service

On the selected host, follow section 4 of [Team deployment mode](../team-mode.md). Merge the final
settings into the service account's machine `happy.toml`, preserving unrelated provider settings:

```toml
[feature.team]
enabled = true
host = "127.0.0.1"
port = 3000
workos_organization_id = "org_REPLACE_WITH_CREATED_TEAM_ID"
owner_workos_user_id = "user_REPLACE_WITH_VERIFIED_OWNER_ID"
workos_client_id = "client_REPLACE_WITH_VERIFIED_CLIENT_ID"

[feature.tailcat]
enabled = true
port = 24779
```

Use the organization ID from step 3, both verified WorkOS IDs from step 1, and the Tailcat port
from step 2. Happy Cloud and the deployment must use the same WorkOS environment. The server does
not need a WorkOS API key or a copied local Happy Cloud refresh token to verify member tokens.

Run `happy-agent run` under the host's service manager. Team mode has no standalone API socket, so
do not use `happy-agent start`, `stop`, `status`, or `reload` to manage it. For the Linux systemd
deployment, restart and inspect it with:

```sh
sudo systemctl restart happy-agent
sudo systemctl is-active happy-agent
sudo journalctl -u happy-agent -n 100 --no-pager
```

Wait for observable startup completion with a bounded timeout, confirm the service stays running
without configuration or provider-startup errors, and confirm the live Tailcat endpoint is still
the one registered with the team. Keep the listener private behind Tailcat and keep WorkOS
authentication enabled. An unauthenticated health request should be rejected; that rejection alone
does not prove authenticated readiness.

The admin bot can verify the running node directly, not just inspect its source code or
configuration. For authenticated diagnostics within the user's task, call `mint_happy_workos_token`
on the local standalone installation:

```json
{ "team_id": "org_REPLACE_WITH_CREATED_TEAM_ID" }
```

Use the returned `access_token` as `Authorization: Bearer <access_token>` for bounded requests to
the intended trusted team node over Tailcat or verified HTTPS. Follow the
[Tailcat request example](../team-mode.md#5-verify-a-team-connection) for the transport; a
`tailcat://` endpoint is not an ordinary HTTP URL. Start with `GET /v0/health`, then inspect
`GET /v0/onboarding` and `GET /v0/profile` to check actual authentication and readiness. After
profile onboarding, use other documented read endpoints relevant to the task to inspect live
state. Read the shipped `API.md` for request and response contracts, execute the checks, and report
what the node actually returned. Code inspection alone does not establish that the deployment
works. Keep changes and agent smoke tests within the user's authorized scope; possessing the token
does not authorize unrelated operations.

The token carries the connected user's permissions in that organization and expires within five
minutes; `expires_at` is its actual expiry in Unix milliseconds. Mint it just before the checks.
WorkOS must have Access token duration set to five minutes or less; the tool withholds longer-lived
tokens. Report that configuration blocker rather than bypassing the limit. Keep the token out of
files, saved connection settings, logs, and final answers; do not forward it to unrelated endpoints
or through redirects. Never copy a refresh token. If an expired token blocks a still-authorized
read, mint a fresh one; do not automatically replay a mutation with an uncertain outcome.

Resolve deployment failures before adding the local connection. These service checks establish
that the host is running and allow direct authenticated diagnostics; the next step also tests the
user's saved local connection and actual agent use.

### Strongly recommended: two machines and a default runner

A shared node runs every member's agents, so advise the user to deploy the team on **two machines
that can reach each other**: one for the node and one for a [dedicated runner](add-runner.md). The
runner dials the node, so it needs an outbound path to the node's Tailcat exposure, or to a private
network address, and no inbound port. Confirm the second machine before members start work, and
add the runner when the user agrees.

Make that runner the default, so nothing runs on the node's own machine. With a single runner it
is the default automatically; with several, set `[runners] default` to the runner's ID. Do not use
`default = "local"` for a team node: it keeps members' work on the node beside the database,
provider credentials, and WorkOS settings, which defeats the separation.

The runner then holds the team's project folders and runs agent commands, Git, and terminals; the
node keeps the database, provider credentials, and WorkOS settings. The runner connects with its
own token, so neither the listener nor WorkOS authentication changes.

If the team cannot provide a second machine, offer to [harden the node with separate Linux
users](harden-node.md) before the service first starts: members' agent commands then run as a
workload user that cannot read the service account's configuration, database, WorkOS settings, or
provider credentials. That cannot be combined with a default runner on the same node.

## 5. Add the local connection and verify it

On the original standalone installation, use `list_remote_connections` with `{}` to check for an
existing entry. Reuse a matching entry or choose an unused ID; `set_remote_connection` replaces an
entry with the same ID, so do not overwrite an unrelated connection.

Once the deployed service checks pass, call `set_remote_connection`:

```json
{
    "id": "acme-team",
    "connection": {
        "name": "Acme Engineering",
        "address": "REPLACE_WITH_EXACT_TAILCAT_ADDRESS",
        "port": 24779,
        "workos_organization_id": "org_REPLACE_WITH_CREATED_TEAM_ID"
    }
}
```

The `address` is the exact case-sensitive Tailcat address, not the full `tailcat://` URL. Supply
the actual Tailcat port and the created team's organization ID. Do not supply a standalone bearer
`token` for a team connection. The connection layer obtains an organization-scoped WorkOS token
from the connected Happy Cloud account automatically. The short-lived diagnostic token from step 4
is only for direct checks; do not extract the connection's credentials or replace its managed
authentication with that token.

This tool saves local machine runtime configuration and applies it without a local daemon
restart. It grants this installation's authenticated clients access to the remote API. It does
not deploy the remote.

Call `check_remote_connection_health` with the selected connection ID:

```json
{ "id": "acme-team" }
```

Require `reachable`, `authenticated`, and `ready` to all be `true`. If unreachable, check the
service, Tailcat address, port, and outbound connectivity. If authentication fails, check Happy
Social sign-in, organization membership, and the exact WorkOS configuration. If not ready, inspect
startup and onboarding status. Never disable authentication or substitute a standalone token to
make a failed check pass.

Finish the authenticated member's profile onboarding as part of setup. Use the profile,
onboarding, and bootstrap contracts in the running release's `API.md`:

1. Read the remote `GET /v0/profile` and `GET /v0/onboarding` as the connected user. Preserve every
   populated remote profile field and existing photo; do not replace them with local values or
   change another member's profile. Fill only missing fields needed for the authorized setup.
2. For a new profile or missing fields needed for setup, reuse the user's existing local profile
   automatically. Call `get_local_profile` on the local standalone installation for the name and
   email; this tool does not return photo data. Read local `GET /v0/profile` and, when it has a
   photo, `GET /v0/profile/photo` for the image bytes. Reuse known values for missing remote
   fields unless the user requested different ones. Ask only for genuinely missing required
   identity information or an interactive requirement; do not hand routine profile setup back
   to the user.
3. Send remote `PATCH /v0/profile` with only the missing name and/or known email, using the
   remote profile's latest `version` in `If-Match`. A new profile requires a non-null name.
   Omit unknown optional values and skip the update if no fields need filling. If the remote
   photo is missing and copying the local photo is part of setup, send its image bytes with
   `Content-Type: image/png`, `image/jpeg`, or `image/webp` as appropriate to remote
   `PUT /v0/profile/photo`, using the latest profile version after any patch in `If-Match`.
   A photo is optional.
   Never copy local profile IDs, versions, private identity, or database files. On a version
   conflict, inspect the returned current profile and preserve concurrent edits rather than
   replaying the old update.
4. Re-read remote `GET /v0/onboarding` after saving. On an already onboarded installation, saving
   the member's profile completes onboarding automatically. Only if `completed` remains `false`
   because installation setup is unfinished and completing that installation is within the user's
   authorized task, call `POST /v0/onboarding/complete` after the profile is saved, then re-read
   onboarding. Adding a connection alone does not authorize changing installation onboarding
   state. Resolve or report any remaining setup requirement.
5. Through the saved local connection, require `GET /v0/bootstrap/desktop` to succeed with
   `onboarding.completed: true` and the documented `config` and current-member `profile` objects.
   Health alone does not prove that Desktop can open the team. `steps.project.done: false` is an
   observation that no project exists, not the completion flag; it can coexist with
   `completed: true`. Do not create a fake permanent project or change administrator privileges
   or credentials to bypass onboarding.

Then verify the experience through that local connection in Happy. For a new deployment, follow
[Testing a deployed node](README.md#testing-a-deployed-node):
create a new temporary project, workspace, and agent, never reuse an existing project, and run a
small inference task with a harmless shell/file check using the configured provider. Confirm a
response and working tools; health alone does not verify model inference or shell sandbox startup.
Coordinate a service restart when no work is active, and recheck connection health to confirm
persistence and recovery. Check whether the user archived the temporary project before each test
action and after the restart; if so, stop without restoring or replacing it. Archive the project
after verification (including failed checks) and confirm its archived state. If an interactive
step requires the user, ask for it and resume verification afterward; do not mark an untested step
as passed.

## 6. Ask whom to invite

Only after the deployment, connection, and smoke test pass, tell the user the team is working and
ask: “Who would you like to invite? Send me their email addresses.” If they already explicitly
provided recipients for this setup, use those without asking them to repeat the list. Otherwise
wait for their answer. Do not infer recipients from Git history, contacts, or the team name.

For each requested email, call `invite_happy_team_member` from the active local admin bot:

```json
{
    "team_id": "org_REPLACE_WITH_CREATED_TEAM_ID",
    "email": "teammate@example.com"
}
```

Invitations grant ordinary membership, not administrator access. Inside the team node, though,
every member's own messages carry the same authority as the owner's, including in Auto permission
review, so invite only people the user trusts with the node. People let in through an
[exported bot](exported-bot-telegram.md) are different: they are guests who can never sign in, and
their messages authorize nothing. Happy Cloud also requires the connected user to be an active
administrator of this specific team. WorkOS controls email
delivery; successful invitation creation does not prove the message was delivered. Report the
actual result, and share any acceptance link only with its intended recipient. See
[Email invitations](../happy-teams.md#email-invitations) for acceptance and delivery caveats.

Do not automatically resend an existing or pending invitation, or retry an ambiguous failure that
may already have sent email. Resolve its status first. Recipients should accept the invitation,
join Happy Social, and bind an email to their account before connecting to the team.

## Completion

Give a concise handoff: team name and ID, deployment location and version, local connection name,
the current member's profile and Desktop bootstrap onboarding results, any inference verification,
and invitation results or the pending request for recipients. Report setup complete only after
`GET /v0/bootstrap/desktop` returns `onboarding.completed: true`; do not claim completion while
Desktop is gated or leave routine profile setup to the user. Do not include credentials, private
identity keys, or invitation links in a general handoff. Keep infrastructure, connection,
onboarding, inference, and invitation outcomes distinct so a partially completed setup is never
reported as fully working.
