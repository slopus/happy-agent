# Happy teams

A Happy team is a WorkOS organization with a registered Happy Agent server endpoint. Creating the
team establishes its membership and makes the connected user its administrator; it does not deploy
a server. A Happy Agent running in team mode serves that organization's members, while a local
connection lets you reach the deployed server from your existing installation.

For the complete agent-executed walkthrough, read
[Create and deploy a Happy team](recipe/deploy-happy-team.md). For server installation and runtime
details, see [Team deployment mode](team-mode.md).

## Start with Happy Social

Check login status first by calling `get_happy_workos_state` with `{}` from an active local admin
bot. A successful result containing `workos_user_id` and `workos_client_id` confirms that the user
is authenticated; proceed without asking them to confirm their login or sign in again. If the
result reports missing or invalid authentication, guide them through the sign-in flow below and
check again afterward. A permission or connectivity error is not evidence that they are logged out.

The user must sign in through **Settings → Account → Join Happy Social** and bind an email address
to that account. Any email address they can access works; a company address or matching company
domain is not required. Complete any email verification requested by the sign-in flow.

Do this on the local, standalone installation that will manage the team. Happy Social account
authentication is separate from the Codex, Claude Code, or other provider credentials used to run
models. The team server still needs its own authorized provider access.

An active local admin bot, such as the Chief of Staff, can guide the whole workflow. Team creation
and listing also work for human-owned root agents, but WorkOS configuration lookup, local connection
management, and email invitations require an active admin bot. Subagents and ordinary bots cannot
take over those administrative steps. The connected user must also be a team administrator in
Happy Cloud to invite members; local bot privileges do not grant organization privileges.

## Setup order

1. Determine Happy Social login status from `get_happy_workos_state`; request sign-in only when
   needed. The account must also have a bound email.
2. Choose the specific team name and an authorized deployment destination. Create the team with
   `create_happy_team`, supplying that name and the server endpoint, and keep the returned team ID.
3. Deploy Happy Agent in team mode using that team ID and the owner's verified WorkOS user and
   client IDs from `get_happy_workos_state`.
4. Verify that the deployed service is running correctly before registering it locally.
5. Add it to local connections with `set_remote_connection`, using WorkOS organization
   authentication. Run `check_remote_connection_health` and verify actual use through that
   connection.
6. Only after those checks pass, ask the user which email addresses to invite. Use
   `invite_happy_team_member` for each requested recipient.

The creation tool requires a real endpoint. With Tailcat, a fresh host must first bootstrap its
stable transport identity; then create the named team and enable team mode. This preparatory step
is not a completed team deployment. Do not invent an endpoint or create a duplicate team just to
change its address. Use `update_happy_team` when an existing team's endpoint needs correction.

Team management runs on the standalone installation, not on the team server. These tools manage
the connected account's organizations, not every organization in WorkOS.

## Email invitations

Once the server and local connection work, ask: “Who would you like to invite? Send me their email
addresses.” Invite only the recipients the user has specified. The tool takes one `team_id` and one
`email`, and creates an ordinary member invitation through Happy Cloud's WorkOS API; it does not
grant administrator access.

Recipients accept their invitation and sign in to Happy Social with an email bound to their
account. WorkOS controls invitation acceptance and delivery. Email delivery must be enabled for
WorkOS to send the message; a successfully created invitation is not proof that an email arrived.
An acceptance link is sensitive and should be shared only with its intended recipient. WorkOS may
allow another address on the same corporate domain to accept an invitation, so do not promise
strict acceptance by only the exact invited address.

An existing-member or pending-invitation response is not a reason to send again. If a request fails
ambiguously, it may already have created or sent an invitation: check its status through the
available administration interface before attempting another invitation.
