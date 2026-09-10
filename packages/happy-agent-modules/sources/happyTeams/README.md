# Happy teams

`HappyTeamsModule` gives standalone root agents three tools backed by the connected Happy Cloud
identity: `list_happy_teams`, `create_happy_team`, and `update_happy_team`. They list the user's
WorkOS organizations and configured Happy Agent endpoints, create one organization with its
required endpoint, or update an existing organization's endpoint. Listing is a fixed 10-item page;
callers follow `next_offset` to read the complete roster without flooding model context.

An active admin bot receives one additional read tool, `get_happy_workos_state`. It refreshes and
reverifies the connected Cloud credential, then returns the exact `user_...` and `client_...`
identifiers needed for `feature.team.owner_workos_user_id` and `feature.team.workos_client_id`. It
reads the client ID from the connected Cloud environment instead of assuming production. The tool
remains separate from `create_happy_team`, so organization creation has one purpose and one result.

An active admin bot can call `mint_happy_workos_token` with `team_id` to connect directly to a
WorkOS-authenticated team node. It returns `access_token`, `team_id`, and the actual `expires_at`
(Unix milliseconds). The credential acts as the connected Cloud user in that organization and
is not limited to one node or to read-only operations. Authority is rechecked on execution; human
roots, subagents, ordinary bots, and archived admins cannot mint through this tool. Auto reviews
credential disclosure, and Read only and Workspace write cannot execute it.

WorkOS controls token lifetime in the application's Sessions settings. Set Access token duration
to five minutes or less: the tool withholds longer-lived, expired, malformed, or mismatched tokens,
without undoing the already-persisted refresh-token rotation. It never manufactures a shorter
expiry for an otherwise longer-lived token. Minting is non-durable and never automatically replayed.
The bearer token appears in the requested tool result/history; no refresh token is exposed. Use it
only with the intended trusted team node, never echo it in a final answer or save it to a file.
Expiry blocks new authenticated requests, not previously started work or an already-open stream.

An active admin bot also receives `invite_happy_team_member`, taking `team_id` and `email`. It uses
Happy Cloud's WorkOS invitation API to invite one member with WorkOS's configured email delivery.
It is not available to human roots, non-admin or archived bots, or subagents, and authority is
checked again when executed. The connected WorkOS user must administer that exact organization.
There is no role or delivery override. The result includes the pending invitation, expiry, and
sensitive acceptance link; share that link only with the intended recipient. WorkOS may allow
another address on the same corporate domain to accept. Creation does not prove email delivery.

Invitation creation is reviewed in Auto and unavailable in Read only or Workspace write. It is
non-durable and is never retried automatically: a failed request may already have sent an email.
Existing members and pending invitations produce distinct, human-readable conflict messages.

The three management tools are present for human-owned root agents and direct bots. A non-admin bot
receives a clear refusal when it calls one, including the installation's admin bots; a human
subagent does not receive them. The WorkOS state tool is absent from human roots, ordinary bots,
archived admin bots, and subagents, and it rechecks the active admin identity when executed. Happy
Cloud remains the authority for organization membership and allows endpoint updates only for the
connected WorkOS user's active administrator membership.

Every call crosses the external Happy Cloud boundary and is reviewed in Auto. Listing and WorkOS
state lookup are durable, reloadable reads. Creation and endpoint updates are non-durable because
their outcomes can be ambiguous after interruption and must not be replayed. Creation validates
both inputs before writing, then creates the organization and sets its endpoint with one
authenticated Cloud credential. If only the first write succeeds, the error preserves the new team
ID and directs the caller to `update_happy_team` instead of risking a duplicate organization.
Team-mode runtimes omit this standalone control-plane surface because their organization is
deployment-owned configuration.
