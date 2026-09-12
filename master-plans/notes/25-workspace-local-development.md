# Easier local experimentation

It would be useful to adopt exact workspace dependencies such as
`workspace:0.0.64`. An outside contributor without package-publishing access
should be able to add a feature to their own Happy Agent, build it locally,
and play with the changes without first releasing SDKs or using custom
dependency-rewriting scripts. Faster experimentation is the goal.

Let pnpm resolve local packages and generate ordinary lockfile changes. Human
review must cover version bumps and actual API-contract changes; publishing
remains a separate maintainer action. Keep the client publishable for Desktop.

This is a separate follow-up to the Agent preview channel. Revise the current
published-only and client-publish-before-implementation policies before making
the workspace migration. Local building must not implicitly install or reload
the running Agent.
