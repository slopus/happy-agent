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
