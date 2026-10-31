# Operational recipes

These documents are step-by-step instructions for recurring Happy Agent tasks. The
[recipe table in the documentation index](../README.md#recipes) lists each recipe and when to use
it. Read the relevant recipe in full before acting, reuse information the user already supplied,
and follow its completion checks. A recipe does not grant permission to change machines, expose
services, or transfer credentials.

Execute recipes automatically by default. The agent owns discovery, configuration, installation,
credential provisioning, service operations, and verification within the user's authorized task;
the command examples are instructions for the agent, not a checklist to hand back to the user.
Reuse known settings and sensible documented defaults. Ask only for missing material choices,
new authority, or access that genuinely requires the user, such as an interactive sign-in. Do not
ask for confirmation of each routine step, and do not bypass permission or credential boundaries.

Recipes ship with Happy Agent and are available beside the installed documentation README, even
when the current agent's workspace is unrelated to the Happy Agent source checkout.

## Testing a deployed node

These rules apply to test commands and agent smoke tests on every deployed Happy Agent node,
both team and standalone (non-team), during setup, upgrades, and later verification.

1. Create a new, clearly named temporary project on the target node for each verification run,
   with its own disposable folder, workspace, and agent. Never reuse an existing project,
   workspace, or agent, including a temporary project left over from an earlier run. Do not use
   the user's initial project or real repository as a test fixture.
2. Run a small inference task through the connection the user will use, using the configured
   provider. Have the agent check its working directory, execute a harmless shell command, and
   create/read a disposable file only inside the temporary workspace. Confirm the response,
   tool execution, and writable storage; health checks alone do not prove inference works.
3. Always check the temporary project's current archival state before sending each task or test
   command, after reconnecting or restarting, and before cleanup. If the user has archived it,
   treat that as a stop: send no further work, do not restore it, and do not automatically create
   a replacement to continue testing. Report any unfinished checks. If its state cannot be
   confirmed, pause rather than assuming it is still active.
4. When verification finishes or fails, archive the temporary project if it is still active and
   confirm that it is archived. If the user already archived it, leave it archived. Use the
   documented project archival operation from the running release's `API.md`; deleting a test
   file or archiving only a workspace does not replace archiving the project. Report incomplete
   cleanup explicitly, and never delete or archive unrelated projects or folders.

Keep tests bounded and within the user's authorized task; inference may incur provider charges.
Inspect existing projects read-only when checking that their state survived an upgrade, but never
send them test messages or run test commands in them.

## Peer messaging

Read [Connect two Happy Agents over one WebSocket](peer-messaging.md) when agents on
two installations need to exchange text using known Agent IDs. The Chief of Staff
configures both ends over existing administration access, then checks the
same authenticated session in both directions. The desktop initiates outbound;
only the reachable installation listens.

## Cleaning up an installation

Read [Clean up an installation](clean-up-instance.md) when the user wants old bots, tasks,
subtasks, projects, workspaces, or folders gone. Only an active admin bot has the cleanup tools.
Archive by default; delete only what the user chose, preview every deletion first, and remember
that deletion erases conversations and cannot be undone.

## Windows and WSL

Read [Set up WSL projects](setup-wsl-agent.md) when adding Linux projects to a Windows installation.
Keep bots on Windows by default and connect a separate Happy Agent in the chosen WSL distribution
through the existing remote connection. Reuse the Linux user's projects and provider login; do not
copy the Windows daemon database or run Windows project tools against a Linux project path.

## Accounts and models

Read [Accounts, models, effort, and service tier](accounts-and-models.md) when the user wants to add
or pool provider accounts, limit models, change default model, effort, or service tier, or move
sessions to another provider. The Chief of Staff edits and validates `happy.toml`; applying the
change follows the configuration reload section.

## Exported bots

Read [Export a bot to Telegram](exported-bot-telegram.md) when the user wants people to reach a
bot from Telegram, and [Export a bot to any chat service](exported-bot-bridge.md) for any other
service, through a bridge program; read either one to change who may. Export a bot of its own,
never the Chief of Staff. The Chief of Staff only exports that bot, and approves or denies the
people whose access requests reach it. Changes apply at once, without a reload. Everyone let in is
a guest whose messages never count as the user's instructions, but the bot works for them with
whatever it can reach, so let each one in only once the user says so.

## Bot settings

Read [Restrict a bot with bot settings](bot-settings.md) when the user wants a bot limited to
certain secrets, kept away from other projects, workspaces, and agents, or run in Docker. An admin
bot changes them with `update_bot_settings`, passing the value `get_bot_settings` returned as
`previous`; a change that widens access is reviewed.

## Happy teams

Read [Create and deploy a Happy team](deploy-happy-team.md) for the complete shared-server workflow:
Happy Social sign-in and a bound email, a specifically named team, a team-mode deployment, a verified
local connection, and only then a request for invitation emails. The companion
[Happy teams guide](../happy-teams.md) explains the account and administration boundaries.

## Runners

Read [Add a dedicated runner](add-runner.md) after deploying any remote node, standalone or team,
and recommend it strongly: the node keeps its database and credentials while a separate machine
runs agent commands, Git, terminals, and project folders. Offer it at the end of both deployment
recipes; do not put the runner on the node's own machine or copy node credentials to it.

## Hardening a node

Read [Harden a node with separate Linux users](harden-node.md) when a machine runs its own agent
work as a service, and offer it whenever a deployment declines a dedicated runner. The service user
keeps the configuration, database, and credentials; agent work runs through sudo as a workload user
that cannot read them, and specific bots can run as users of their own. Apply it before the daemon
first starts, because folders are placed in the workload user's home. It cannot be combined with
runners on one node.

## Enterprise sign-in

Read [Set up enterprise JWT sign-in](enterprise-jwt-authentication.md) when a team should sign in
with its own identity provider instead of WorkOS. The Happy app signs in with the organization's
OAuth authorization server directly, using the authorization code flow with PKCE and optional
refresh; the daemon only verifies the resulting access token and never sees codes or refresh
tokens.
