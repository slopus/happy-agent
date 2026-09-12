# Releases: local tier design and stable ordering

Proposal supporting [master plan 25](../25-releases.md). It covers how the
local tier should work and raises two points where the plan needs the owner's
decision. The master plan is the authority where the two disagree. Reviewed by
Claude Fable 5.1 and GPT-6 Astra at max effort; both agree on the shape below.

## What we learned from the current code

Every process derives its whole filesystem layout from one variable,
`HAPPY_HOME_DIR`, defaulting to `~/.happy`. The agent's config module, the
terminal, and Happy Desktop's Electron main process all apply the same rule.
The public sibling directory (`~/Happy/Config` on macOS) is derived from the
parent of the private root, so moving the root moves configuration with it.
Desktop forwards the variable to any agent it spawns. Desktop's own UI
preferences file ignores it.

The agent's `reload` command starts the new daemon from whatever executable
ran the command. Running `reload` from the checkout's built CLI replaces the
running daemon with the checkout, with no installer. That is why `pnpm dev`
works today. Clients connect to an already running daemon first and only spawn
the binary selected in `dist/config.json` when nothing is running.

Releases are driven by an agent, not a person. The agent dispatches the
workflow, watches it, reads the failure, commits a fix to main, and dispatches
again. Builds fail routinely. Any release or local flow must be designed for
that loop, not for a clean one-shot run.

## Local tier

Two commands, one variable, no installer script, no fixed version slot.

```
pnpm local          build → pack SDK tarballs → install the Bun binary at
                    <home>/dist/version/<local-version>/happy-agent
                    → save the current selection once → select the local build
                    → reload from it
pnpm local:off      restore the saved selection → reload from it
                    → exit the SDK tarball override state
```

Isolation is not a separate mode. It is the same command with `HAPPY_HOME_DIR`
pointing at a checkout-local directory. A thin `pnpm local:isolated` may set
the variable, seed `happy.toml` from the real config home, and print the launch
line for Desktop. On macOS a Dock-launched Desktop never sees shell exports, so
the helper prints:

```sh
open -a "Happy Desktop" --env HAPPY_HOME_DIR=<path>
```

Rules the commands must follow:

- Each isolated instance gets its own parent directory, for example
  `.local/instances/<name>/.happy`. Two homes under one parent would share a
  public config directory.
- The command is synchronous and rerunnable. A failed step leaves the running
  daemon and the current selection untouched so the driving agent can inspect
  the failure, fix it, and run again. The build is never detached.
- Only the final activation may detach, and only when the process driving the
  command lives inside the daemon it is replacing. `reload` drains active tool
  work, so waiting inside that work for its own reload deadlocks. The
  rewritten local-agent skill chooses the detached activation and ends its
  turn; a shell user gets the synchronous path. This is about process
  ownership, not about who typed the command.
- `local:off` restores the exact selection it replaced, saved once on the first
  activation and not overwritten by later rebuilds. Restoring is allowed to be a
  downgrade and needs no network. In a fresh isolated home with no prior
  selection, off stops the local daemon. Restoration metadata lives beside
  `dist/config.json`, not inside it, because both clients reject unknown keys
  in that file.
- The local build must resolve every SDK consumer, including transitive ones,
  from the packed tarballs. A compile that succeeds against published pins
  proves nothing about a local SDK change. Off must also exit the tarball
  override, otherwise later workspace installs keep resolving from stale
  tarballs.
- `pnpm dev` stays as it is. It is the fast isolated edit loop: Node reload
  plus the TUI, no Bun compile. It shares SDK preparation and config seeding
  with `pnpm local`, not the runtime.

## Decision needed: the local version slot

The plan says local installs land at `dist/version/<tree-version>/`. A bare
tree version such as `0.4.51` occupies the directory the real `0.4.51` stable
will later download into, and update logic will believe that stable is already
present.

Proposal: the local version is a prerelease derived from the tree version and a
build identity, `0.4.51-local.<build-id>`. The identity must reflect the actual
build inputs, including the packed SDKs; a short commit hash alone is not
enough because two dirty worktrees can share a HEAD. The count of local
versions must stay bounded, since both clients reject a catalog with more than
one hundred downloaded versions.

Two consequences need separate work once this is approved:

- The terminal's upgrade command today refuses to move from a local
  prerelease down to the previous stable. `local:off` restoring the saved
  selection avoids this path, but the upgrade command must not be documented
  as the way off a local build until it handles the downgrade.
- Desktop merges local version directories into its picker, labels them as
  non-prerelease, and can offer an old local build as a ready update after
  off. Local builds need explicit presentation and exclusion from update
  candidates in the Desktop repository.

## Decision needed: stable ordering under fixups

The plan closes the version window by pushing "Start 0.4.51" before
dispatching the promote. If the promote build then fails on any target, the
fix commit's tree says `0.4.51` and can no longer ship as `0.4.50`. With builds
that fail routinely, this collision is the normal case.

Proposal: split preparation from publication.

```
1. dispatch prepare   build, test, sign, and retain every stable artifact for
                      the candidate at its manifest version; no tag, no publish
2. watch, fix on main, dispatch prepare again until green
3. push "Start 0.4.51"
4. dispatch publish   consume the exact prepared run, tag its source commit,
                      upload the retained artifacts, mark latest; never rebuild
5. verify assets, npm, and release body
```

Main still says `0.4.50` through the whole fix loop, so every fix keeps its
intended version and also gets its ordinary preview. The window closes only
after green and before anything is published. This keeps every plan invariant:
no bot commits to main, no typed versions, the tagged commit's tree says the
version, and the product manifest is always unpublished. It changes the plan's
sequencing from "bump then rebuild" to "prepare, fix, bump, publish".

After the bump, an upload or registry failure retries the same prepared bytes.
A source change after the bump reopens the decision or advances the version;
it never pretends an immutable candidate contains the fix.

The fallback, if the split is rejected, is a single build-and-publish run
followed by the bump. That relaxes "always unpublished" for the minutes
between publication and bump and leaves a race with previews built in that
window.

The rewritten release-agent skill should state the fix-and-redispatch loop
explicitly, including the point after which a source retry is no longer legal.
The current skill documents dispatch and verification but never names the loop
that actually runs.

## What this retires

Once the local tier lands: the root `link:global` and `unlink:global` scripts,
the terminal's `install-local-agent.ts`, the local-agent reload helper, and the
fixed `0.0.0` slot. Once the preview channel lands: the canary job and its
scripts, the beta path, and the distribution-tag resolver. Once stable lands:
the typed-version inputs, the ephemeral version rewrite, and the workflow's
commit to main. Library releases through `pnpm release <package> patch` and
the tag-triggered library workflows stay.
