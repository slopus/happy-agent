# Report a Happy bug

Use this recipe when the user wants to report a problem with Happy. Happy Desktop's "Report from
current chat" adds a draft to the chat where the bug happened, with "What happened", "Expected",
and an optional screenshot. Start from that chat's own history: it usually shows the bug already.

## 1. Thank the user

Thank them for spending their time and tokens. We prioritize bugs, and setups vary so much that
their help reproducing one on their own machine is valuable.

## 2. Gather the essentials

Use the chat and the draft first, and don't ask for anything already there. Collect the rest
yourself: the Happy Agent version (`happy-agent --version`), the app version, the OS, the provider
and model, and the relevant lines of `~/.happy/agent/daemon.log`. Never include tokens, keys,
cookies, passwords, or other secrets, and replace private paths and names with placeholders.

## 3. Choose the depth

Ask whether they want a well-written issue, or for you to also reproduce the bug, find the root
cause in https://github.com/slopus/happy-agent, and prepare a fix as a pull request. Reproduce in a
disposable folder, never in their real projects or settings.

## 4. Offer next steps

Show the finished report and offer links:

- A GitHub issue prefilled with percent-encoded `title` and `body`:
  `https://github.com/slopus/happy-agent/issues/new?title=...&body=...`
- A pull request with the fix, if there is one.
- A post on X tagging @happy\_\_eng: `https://x.com/intent/post?text=...`
- The Happy Discord: https://discord.gg/fX9WBAhyfD

A reproduction posted on X or Discord, especially with a fix, is the fastest way to get it merged.

## 5. Publish only with the user's OK

Don't open an issue or pull request, push, or post anywhere without the user's explicit OK for
that item. Links they open themselves are fine.
