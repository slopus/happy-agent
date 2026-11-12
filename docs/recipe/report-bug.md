# Report a Happy bug

Use this recipe when the user wants to report a problem with Happy: Happy Desktop, the mobile
apps, or Happy Agent. The bug button in Happy Desktop opens a task that points here. The user's
own account of what happened follows the line `---- Explain what happened below -----` in their
first message.

## 1. Thank the user

Start by thanking them for spending their time and tokens on this. Tell them we prioritize bugs,
and setups vary so much that their help reproducing a problem on their own machine is valuable.
Keep it to a sentence or two, then get to work.

## 2. Gather the essentials

Read the user's description first and don't ask again for anything they already wrote. Collect
the rest yourself where you can:

- **What happened**: what they did, what they expected, what happened instead, and whether it
  happens every time.
- **Happy Agent version**: `happy-agent --version`, and the Happy Desktop or mobile app version if
  the bug shows up there. Ask the user for an app version only when you can't find it.
- **Operating system** and version, and whether the agent runs locally, on a remote, or on a team
  server.
- **Provider and model** in use, such as `claude` with a named model, and the harness if one is
  involved.
- **Relevant logs**: the lines around the failure in `~/.happy/agent/daemon.log` and
  `~/.happy/agent/observation/agent.log` (under `HAPPY_HOME_DIR` if it is set), or the error text
  the app showed. Quote only the lines that matter.

Never put secrets in a report. Remove tokens, API keys, cookies, passwords, private keys,
`Authorization` headers, and the contents of `~/.happy/agent/token`. Replace private paths,
hostnames, emails, and repository names with placeholders unless the user wants them kept.

## 3. Choose the depth

Ask the user how far they want to go:

- **Write the issue**: a clear, well-written report with what you gathered.
- **Find and fix it**: also try to reproduce the bug, find the root cause in the source at
  https://github.com/slopus/happy-agent, and prepare a fix as a pull request.

For either one, try a quick reproduction when it is cheap and safe, and say in the report whether
it reproduced. When you look for the root cause, point at the file and line. When you prepare a
fix, put it on its own branch with the smallest test that reproduces the bug, and follow the
repository's `AGENTS.md`. Don't change the user's real projects or settings to reproduce it; use a
disposable folder.

## 4. Offer next steps

Show the user the finished report, then offer these concrete options with links ready to click:

- **Open a GitHub issue**: link to https://github.com/slopus/happy-agent/issues/new with
  `?title=...&body=...`, both percent-encoded, so the issue opens already filled in. If the body
  would make the link longer than about 6,000 characters, put a short summary in the link and
  give the user the full report to paste.
- **Open a pull request** with the fix, if one was prepared.
- **Post on X** tagging @happy\_\_eng and @bra1n_dump or @ex3ndr, using
  `https://x.com/intent/post?text=...` with a short percent-encoded summary and a link to the
  issue or pull request.
- **Post in the Happy Discord**: https://discord.gg/fX9WBAhyfD

Tell the user that posting a reproduction on X or Discord, especially with a fix, is the fastest
way to get it merged.

## 5. Publish only with the user's OK

Don't open an issue or pull request, push a branch, or post anywhere without the user's explicit
OK for that specific item. Show them the exact text first. A link they open themselves is fine to
give at any time.
