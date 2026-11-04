---
name: release-agent
description: Release Happy Agent from this repository. Use when asked to "release", "release the agent", "cut a release", or to publish a new version. Covers version selection, building the release notes, dispatching the workflow correctly, and verifying the published result.
---

# Releasing Happy Agent

Releases go out through GitHub Actions using trusted publishing. Never publish from local
npm credentials, and never create or push a release tag by hand — the workflow creates the
tag, and it only does so after the build and publication have succeeded.

The [release master plan](../../../master-plans/25-releases.md#coordinating-requested-releases)
coordinates Agent, Desktop native, and hosted renderer releases. Preserve the
user's authorized scope across handoffs under the runtime's trusted authorization
policy. Do not re-ask preemptively for authorized work. If the runtime denies an
action, stop it, explain the denial, and follow its rules for fresh approval.
Publish and verify changed SDKs before updating consumers, then
prepare and dispatch independent products in parallel once their dependencies
are ready. Wait only at actual dependency gates, and verify every requested
product before reporting completion.

## Which product, which version

An unqualified "release" means **a Happy Agent preview**. Production must be explicit.
Neither means a library unless that library is named.

Before choosing production, check that the user explicitly requested a production or stable
release for this product in the current task. A request to "release", "ship", or push is not
production authorization; default to preview. An existing explicit request is sufficient:
do not ask for redundant confirmation.

Use the candidate ourselves in the affected workflows for at least a brief soak before releasing
it to production. Passing tests or CI alone does not count as that use. If the candidate has not
been used, keep it in preview and explain what still needs to be tried. No fixed soak duration or
previously published preview is required.

| Request              | Product      | Version                              |
| -------------------- | ------------ | ------------------------------------ |
| "release"            | Happy Agent  | next patch followed by `-preview.N`  |
| "release production" | Happy Agent  | next stable patch; no preview needed |
| "release stable"     | Happy Agent  | same as production                   |
| a named library      | that library | next patch                           |

Read Agent versions from GitHub releases/tags, not its npm package or source manifest.
Use npm for libraries. Fetch tags before choosing an unused version:

```bash
gh release list --limit 30
gh api repos/slopus/happy-agent/releases/latest --jq .tag_name
git tag --list 'v[0-9]*' --sort=-v:refname | head -10 # Happy Agent
```

For stable `X.Y.Z`, use the next patch after the latest stable Agent release. For previews,
append the next unused `-preview.N` (start at 1). Example: `0.4.67-preview.1`.
No package manifest bump or SDK publication is required just to assign this binary identity.
Existing pinned SDK dependencies must still resolve. Never reuse or move a failed tag;
advance the preview number or stable patch as appropriate. A push never publishes a preview.

## Before dispatching

1. **Be on current `origin/main`.** The workflow refuses to run unless `HEAD` equals
   `origin/main` and the ref is `refs/heads/main`. Fetch and rebase first. The release's
   [update card file](#writing-the-update-card-file) must already be on `main`.
2. **Reinstall after any rebase.** A rebase that moves a published SDK dependency leaves
   `node_modules` stale, and the failure shows up as unrelated type errors:
    ```bash
    CI=true pnpm install --frozen-lockfile
    ```
3. **Run the tests on Node 24.** The repo targets Node 24; a newer Node produces failures
   that are artifacts of the Node version rather than real:
    ```bash
    export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
    pnpm test
    ```
    The gym is a separate suite with its own failure modes. Gym failures do not necessarily
    block a release, but establish whether they are pre-existing before deciding — build a
    worktree at the commit before yours and reproduce there.

## Counting what is in the release

Count commits against the **product and channel's own last release**, not the last tag of
any kind. For the first preview of a stable target, start from the latest stable release;
production notes include everything since the previous stable, including previewed changes:

```bash
git log --format='%h %s' v0.3.17..origin/main
```

Do not scope this count to the product's package directory. Happy Agent ships the modules
and providers packages, so a change in `packages/happy-agent-modules` is in the release even
though it never touches `packages/happy-agent`. Reporting the directory-scoped count as
the total understates the release — verify the number you quote by running the unscoped
command above.

Read the commit bodies, not just the subjects. The bodies explain what actually broke and
what the user will notice:

```bash
git log --format='%h%n%s%n%b%n---' v0.3.17..origin/main
```

## Writing the notes

The notes are user-facing Markdown. Write for someone who uses the product and does not read
the repository.

- Explain what was wrong and what is different now. Never paste commit subjects or a raw
  changelog.
- Group by what the person experiences, under `##` headings, not by package or commit order.
- Say plainly what a bug did to them — "every restart drained forever waiting on an agent you
  could not see" is worth more than "fixed daemon drain".
- Leave out internal mechanics they cannot observe: transaction boundaries, module structure,
  lifetimes, test scaffolding.

Write the notes to a file under `.context/`, which is scratch and gitignored:

```bash
.context/release-notes.md
```

## Writing the update card file

Every Agent release, preview and production alike, also gets a very short file at
`release-notes/<tag>.md`, for example `release-notes/v0.4.106.md` or
`release-notes/v0.4.106-preview.5.md`. Happy Desktop's update card reads it from `main` and lists
the bullets of every release between the installed version and the new one, newest first, without
rewriting them. It is an extra artifact; keep writing the full notes above for the GitHub Release.

```md
## Features

- Sidebar sorts work by topic
- New work appears instantly

## Fixes

- Reliable task and bot names
```

- Cover the same range as the full notes: a preview covers only what changed since the previous
  release on its channel, so previews are more detailed; production covers everything since the
  previous stable.
- Write two or three bullets in total for most releases, and never more than three per section.
  Pick what a person would notice; leave out internal work entirely.
- Each bullet is three to six plain words, ideally three, with no Markdown, links, code, or
  trailing period.
- Label experimental or off-by-default features with `(Beta)` in the bullet. The website
  changelog at `https://happy.engineering/changelog/` contains production releases only,
  newest first; previews use these files and GitHub Release notes. Coordinate production
  feature entries and their dedicated share pages with the website owner.
- New capabilities go under `## Features`; things that stopped going wrong go under `## Fixes`.
  The card shows features first and fixes behind a tab. Omit a section with nothing in it.

### Thanking the people behind a fix

When a fix in the release came from someone outside the team, such as an issue whose logs,
repro, or root cause led to it, thank them in a `## Thanks` section after the others. Each
bullet is `@login` and the issues or pull requests they are credited for, in slopus/happy,
happy-agent, or happy-desktop; at most eight people:

```md
## Thanks

- @shellus slopus/happy-agent#73
- @acidsatan slopus/happy-agent#74 slopus/happy#1941
```

Happy Desktop's update card lists them behind a collapsed Happy contributors row with their
avatars and links. Find candidates in the commit bodies of the range (`git log --format='%h%n%b'`)
by the issues they cite, and read each issue before crediting its author. Thank people for
reports and changes that shaped a fix in this release, not for every issue they filed, and
never thank a team member here. Production files repeat the people their previews thanked.

End the full GitHub notes with the same people, linked, and one line on what each one gave:

```md
## Thanks

- [@shellus](https://github.com/shellus) found why Windows sandbox commands exited 125 ([happy-agent#73](https://github.com/slopus/happy-agent/issues/73))
```

GitHub notifies everyone a release mentions, so a Thanks section is a message to those people.
Include one only when the person who asked for the release has approved those names.

Check it, then commit it on its own and push that commit to `main` as part of the requested
release — the workflow only runs from the current `origin/main`, and it fails before building
when the file is missing or invalid:

```bash
node scripts/release/validateReleaseNotes.ts v0.4.67-preview.1
git add release-notes/v0.4.67-preview.1.md
git commit -m "Add release notes for v0.4.67-preview.1"
git push origin HEAD:main
```

If `main` moved, rebase and push again without force.

## Dispatching

**`gh` needs `@` to read a file into a workflow input.** Without it the literal path string is
submitted as the release body, the workflow succeeds, and the published release reads
`.context/release-notes-0.3.18.md` instead of the notes. The workflow's blank-notes check does
not catch this, because a path is not blank.

```bash
# Preview example — use the version you selected, not this literal example
gh workflow run release-happy-agent.yml --ref main \
    -f version=0.4.67-preview.1 -F prerelease=true \
    -F release_notes=@.context/release-notes.md
```

`-f` is a literal string; `-F` reads a file only when the value begins with `@`. For short
single-line values `-f` is fine.

Immediately before a production dispatch, verify both the explicit user request for this product
and our actual use of this candidate. Only then supply the stable version and `-F prerelease=false`.
CI builds, tests, signs, and publishes the same artifacts within one workflow run.
Do not introduce a separate prepare/publish dispatch or bump commit between those jobs.
Source verification and platform builds overlap after release-input validation;
publication still waits for all gates. Retries reuse verified unsigned native
outputs when all native inputs match; native checks and final binary tests,
signing, and notarization still run for each release.

## Verifying

Watch the run to completion, then **read back the published body** — this is the step that
catches the `@` mistake:

```bash
gh run watch <run-id> --exit-status
gh release view v0.4.67-preview.1 --json body -q .body
```

The body must be the notes. If it is a file path, repair it in place — the artifacts are fine,
only the body is wrong, so there is no need to re-release:

```bash
gh release edit v0.4.67-preview.1 --notes-file .context/release-notes.md
```

Confirm the update card can read the short file:

```bash
curl -fsS https://raw.githubusercontent.com/slopus/happy-agent/main/release-notes/v0.4.67-preview.1.md
```

Then confirm the rest:

```bash
# Happy Agent: four platform archives plus a .sha256 for each; never a draft
gh release view v0.4.67-preview.1 --json tagName,isDraft,isPrerelease,assets \
    -q '"tag=\(.tagName) draft=\(.isDraft) pre=\(.isPrerelease)", (.assets[] | .name)'
```

Use your actual tag in each command. Verify preview releases have `isPrerelease=true` and
leave GitHub's latest stable unchanged; production has `isPrerelease=false` and becomes
latest. Download assets with `gh release download <tag> --dir <scratch-directory>` and run
`shasum -a 256 -c <archive>.sha256` there for each archive. On a supported host, extract its
archive and check the binary's `--version`; do not start the daemon. Nightly accepts supported
Agent previews; standard Desktop must not offer them. No app or daemon restart is implied
by a release request.

## After the release

Report the version, where it was published, and anything you knowingly left unfixed. If tests
failed or a suite was skipped, say so with the output rather than reporting a clean release.

## Sandbox notes

Several Git operations need to write inside `.git` and are refused by the workspace sandbox —
`fetch` writing `FETCH_HEAD`, `checkout` and `rebase` taking `index.lock`. Request reviewed
full-access execution for those specific commands. Do not work around a refusal by another
route, and be careful pairing a blocked Git command with a destructive one in the same shell
line: if the Git command is refused, the second command still runs.

On macOS, Git commands print `xcodebuild` and `confstr` noise from the sandbox. It is harmless;
filter it when it obscures real output.
