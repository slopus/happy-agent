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
