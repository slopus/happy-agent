# Report a Happy bug

Use this recipe when the user wants to report a problem with Happy. Happy Desktop's "Troubleshoot"
button starts a new task with a template as its draft: "What happened", "Expected", an optional
screenshot, a "Context" line with the desktop version, OS, and IDs when known, and "Started from"
with a `happy://` link to the chat, Surface, or artifact the user was viewing, if any. Work directly
in this task.

## 1. Thank the user and read where it started

Thank them for spending their time and tokens. We prioritize bugs, and setups vary so much that
their help reproducing one on their own machine is valuable.

If there is a "Started from" link, read what it points to before asking the user anything: for
`happy://agents/<id>`, that conversation with `read_agent_history`; for `happy://surfaces/<id>`,
that Surface with the Surface tools; for `happy://artifacts/<id>`, that artifact with the artifact
tools.

## 2. Gather the essentials

Use the template, the Context line, and what you read first, and don't ask for anything already
there. Collect the rest yourself, such as `happy-agent --version`, the provider and model, and the
relevant lines of `~/.happy/agent/daemon.log`. Never include secrets, and replace private paths and
names with placeholders.

## 3. Choose the depth

Ask whether they want a well-written issue, or for you to also reproduce the bug in a disposable
folder, find the root cause in https://github.com/slopus/happy-agent, and prepare a fix as a pull
request.

## 4. Offer next steps, and publish only with the user's OK

Show the finished report and offer links: a GitHub issue prefilled with percent-encoded `title`
and `body` (`https://github.com/slopus/happy-agent/issues/new?title=...&body=...`), a pull request
with the fix if there is one, a post on X tagging `@happy__eng`
(`https://x.com/intent/post?text=...`), and the Happy Discord, https://discord.gg/fX9WBAhyfD. A
reproduction posted on X or Discord, especially with a fix, is the fastest way to get it merged.

Don't open an issue or pull request, push, or post anywhere without the user's explicit OK for
that item. Links they open themselves are fine.
