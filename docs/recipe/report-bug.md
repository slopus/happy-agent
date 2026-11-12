# Report a Happy bug

Use this recipe when the user wants to report a problem with Happy. Happy Desktop's
"Troubleshoot" button adds a template to the open chat's draft, or starts a new task with it when
no chat is open: "What happened", "Expected", an optional screenshot, and a "Context" line with the
desktop version, OS, and agent or chat ID when known.

## 1. Thank the user and keep their chat on track

Thank them for spending their time and tokens. We prioritize bugs, and setups vary so much that
their help reproducing one on their own machine is valuable.

In a chat that was doing other work, hand the investigation to a subtask with `create_subtask`, so
that chat isn't derailed. When reproducing or fixing code, give it a workspace of the relevant
project, such as happy-agent or happy-desktop. Pass it this recipe's path, the bug description,
the Context line, and the excerpts and details from this chat that show the bug. It reports back,
and the user decides on publishing from there. In a new bug-report task, do the work yourself.

## 2. Gather the essentials

Use the template, the Context line, and the chat first, and don't ask for anything already there.
Collect the rest yourself, such as `happy-agent --version`, the provider and model, and the
relevant lines of `~/.happy/agent/daemon.log`. Never include secrets, and replace private paths
and names with placeholders.

## 3. Choose the depth

Ask whether they want a well-written issue, or for you to also reproduce the bug in a disposable
folder, find the root cause in https://github.com/slopus/happy-agent, and prepare a fix as a pull
request.

## 4. Offer next steps, and publish only with the user's OK

Show the finished report and offer links: a GitHub issue prefilled with percent-encoded `title`
and `body` (`https://github.com/slopus/happy-agent/issues/new?title=...&body=...`), a pull request
with the fix if there is one, a post on X tagging @happy\_\_eng
(`https://x.com/intent/post?text=...`), and the Happy Discord, https://discord.gg/fX9WBAhyfD. A
reproduction posted on X or Discord, especially with a fix, is the fastest way to get it merged.

Don't open an issue or pull request, push, or post anywhere without the user's explicit OK for
that item. Links they open themselves are fine.
