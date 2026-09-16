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

## Windows and WSL

Read [Set up WSL projects](setup-wsl-agent.md) when adding Linux projects to a Windows installation.
Keep bots on Windows by default and connect a separate Happy Agent in the chosen WSL distribution
through the existing remote connection. Reuse the Linux user's projects and provider login; do not
copy the Windows daemon database or run Windows project tools against a Linux project path.

## Happy teams

Read [Create and deploy a Happy team](deploy-happy-team.md) for the complete shared-server workflow:
Happy Social sign-in and a bound email, a specifically named team, a team-mode deployment, a verified
local connection, and only then a request for invitation emails. The companion
[Happy teams guide](../happy-teams.md) explains the account and administration boundaries.
