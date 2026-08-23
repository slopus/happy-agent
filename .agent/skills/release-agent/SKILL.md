---
name: release-agent
description: Release Happy Agent or Happy Terminal from this repository. Use when asked to "release", "release the agent", "release terminal", "cut a release", or to publish a new version. Covers version selection, building the release notes, dispatching the workflow correctly, and verifying the published result.
---

# Releasing Happy Agent

Releases go out through GitHub Actions using trusted publishing. Never publish from local
npm credentials, and never create or push a release tag by hand — the workflow creates the
tag, and it only does so after the build and publication have succeeded.

## Which product, which version

An unqualified "release" means **the next patch of Happy Agent**. It never means Happy
Terminal, and it never means a library.

| Request            | Product        | Version                               |
| ------------------ | -------------- | ------------------------------------- |
| "release"          | Happy Agent    | next patch                            |
| "release terminal" | Happy Terminal | next stable patch, never a prerelease |
| a named library    | that library   | next patch                            |

Read the current version from the published package rather than from the working tree, and
confirm it against the tags:

```bash
gh release list --limit 5
git tag --list 'v0.3.*' --sort=-v:refname | head -3            # Happy Agent
git tag --list 'happy-terminal-v*' --sort=-v:refname | head -3 # Happy Terminal
npm view @slopus/happy-terminal version
```

If a tagged release failed before publication, its tag may exist unpublished. Advance to the
next patch and dispatch again. Never reuse or move a failed tag.

## Before dispatching

1. **Be on current `origin/main`.** The workflow refuses to run unless `HEAD` equals
   `origin/main` and the ref is `refs/heads/main`. Fetch and rebase first.
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

Count commits against the **product's own last tag**, not the last tag of any kind:

```bash
git log --format='%h %s' v0.3.17..origin/main               # Happy Agent
git log --format='%h %s' happy-terminal-v0.3.3..origin/main # Happy Terminal
```

Do not scope this count to the product's package directory. Happy Terminal ships the modules
and providers packages, so a change in `packages/happy-agent-modules` is in the release even
though it never touches `packages/happy-terminal`. Reporting the directory-scoped count as
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
.context/release-notes-0.3.18.md
```

## Dispatching

**`gh` needs `@` to read a file into a workflow input.** Without it the literal path string is
submitted as the release body, the workflow succeeds, and the published release reads
`.context/release-notes-0.3.18.md` instead of the notes. The workflow's blank-notes check does
not catch this, because a path is not blank.

```bash
# Correct — the @ makes gh read the file
gh workflow run release-happy-agent.yml --ref main \
    -f version=0.3.18 \
    -F release_notes=@.context/release-notes-0.3.18.md

# Wrong — submits the literal path as the release body
gh workflow run release-happy-agent.yml --ref main \
    -f version=0.3.18 \
    -F release_notes=.context/release-notes-0.3.18.md
```

`-f` is a literal string; `-F` reads a file only when the value begins with `@`. For short
single-line values `-f` is fine.

Happy Terminal is the same call against `release-happy-terminal.yml`.

## Verifying

Watch the run to completion, then **read back the published body** — this is the step that
catches the `@` mistake:

```bash
gh run watch <run-id> --exit-status
gh release view v0.3.18 --json body -q .body | head -20
```

The body must be the notes. If it is a file path, repair it in place — the artifacts are fine,
only the body is wrong, so there is no need to re-release:

```bash
gh release edit v0.3.18 --notes-file .context/release-notes-0.3.18.md
```

Then confirm the rest:

```bash
# Happy Agent: four platform archives plus a .sha256 for each, not a draft or prerelease
gh release view v0.3.18 --json tagName,isDraft,isPrerelease,assets \
    -q '"tag=\(.tagName) draft=\(.isDraft) pre=\(.isPrerelease)", (.assets[] | .name)'

# Happy Terminal: npm must show the new version on the latest tag
npm view @slopus/happy-terminal version dist-tags --json
```

For Happy Terminal, npm publication happens before the tag and GitHub Release are created, so
a failed publish must leave both absent. If a tag exists without an npm version, something is
wrong — investigate rather than retrying.

## After the release

The Happy Terminal workflow pushes a version bump commit to `main`. Fast-forward so the local
branch is not left behind:

```bash
git pull --ff-only
```

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
