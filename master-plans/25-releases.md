# Preview releases

Support requested previews of Happy Agent, the Desktop native app, and the
Desktop hosted renderer. Nightly consumes previews; standard stays stable-only.
Keep the existing release flows: no cross-run coordinator or separate
prepare/publish dispatches.

## Agent instructions and scripted work

People request releases; agents follow the release Markdown instructions using
existing Git, pnpm, and GitHub CLI commands. Keep utilities small. The existing
workflow owns deterministic build, test, signing, and publication work.

```text
Maintainer: "Release Happy Agent"
+-- Agent: review main, choose an unused preview version, write notes
+-- Agent: dispatch existing workflow with version, notes, prerelease=true
    +-- CI: validate; build/test the four platform binaries
    +-- CI: sign/notarize, smoke-test, archive, checksum
    `-- CI: publish those artifacts as a GitHub prerelease in this run
+-- Agent: gh run watch; verify published version, notes, assets
`-- Desktop Nightly: discover/download through its existing Agent update path
```

An unqualified release of any of these products means preview. Explicit
production requests use the existing stable flow, without requiring a prior
preview. A push does not publish previews. Preserve source checks, signing,
tests, checksums, and protection against replacing published assets.

Desktop native previews use the existing signed app build and publication
workflow, with a version/notes/prerelease input and Nightly-only artifacts.
Stable releases still ship both app flavors. Nightly's native updater must
accept previews and later stable versions through its existing install action.
Renderer previews use the existing hosted build/Pages deployment workflow,
manually requested, targeting Nightly's existing URL. No native release is
implicit in a renderer request. Standard bundles its renderer, so renderer
production delivery requires explicit native-release scope.

## Versions and distribution

Use `X.Y.Z-preview.N`, for example `0.4.67-preview.1`. The agent selects the
intended stable version and next unused preview number from release history;
CI validates the input. Keep the existing version input. Embed preview identity
in the binary without requiring package manifest bumps or npm publication.
A stable request supplies `X.Y.Z`; no intervening bump commit is required
between building and publishing.

Nightly accepts supported stable and preview Agent versions; standard Desktop
accepts stable only. Previews must not replace GitHub's latest stable release.
This is an Agent binary channel, not an npm canary channel. Client/SDK releases
are not inherently part of an Agent preview; existing published dependencies
must still resolve until workspace use changes.

## Scope and order

1. Discard the unshipped coordinator redesign and unrelated pipeline changes.
   Start from the original Agent workflow and release instructions; the workflow
   already supports GitHub prereleases.
2. Standardize preview naming/defaults and update Nightly's Agent discovery.
   Preserve standard's stable-only behavior and existing activation controls.
   Remove automatic npm canary publishing and its unused helpers; retain stable
   library publication. Put orchestration in concise release instructions.
3. Add native and renderer previews by extending their existing workflows and
   Nightly updater. Remove the new Desktop release coordinator and version-bump
   ceremony. Deliver host changes through the existing native install mechanism;
   a renderer refresh alone cannot deliver them.
4. Verify each requested preview reaches Nightly without reaching standard;
   preserve the Agent's four platform archives and native signing gates. Verify
   stable releases still work directly.

Do not redesign Terminal or stable library publishing. Use existing CLI commands
and small necessary helpers, not custom workflow-run tracking or artifact stores.

## Separate contributor-development direction

Consider exact workspace pins separately so outside contributors can experiment
locally without publishing SDKs or dependency hacks. See the
[local-development note](notes/25-workspace-local-development.md). This is not a
prerequisite for the preview channel or a decision to stop publishing libraries.
