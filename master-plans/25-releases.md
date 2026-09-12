# Releases

Three tiers: local (test the full assembly, nothing published), preview (auto
on every push, team only), stable (machine-led, watched, never silent).
Nobody types a version anywhere. Every released version has exactly one
commit whose tree says that version.

## Everything we release

| #   | Artifact                           | Repo                                                     | Distributed via                 | Released by                                |
| --- | ---------------------------------- | -------------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| 1   | Happy Agent binary (4 targets)     | [happy-agent](https://github.com/slopus/happy-agent)     | GitHub Releases only, never npm | preview: auto on push; stable: promote     |
| 2   | `@slopus/happy-terminal`           | happy-agent                                              | npm `latest` only               | machine-led dispatch, stable only          |
| 3   | `@slopus/happy-agent-client`       | happy-agent                                              | npm `latest`                    | `pnpm release`, inert until repin          |
| 4   | `@slopus/happy-agent-base`         | happy-agent                                              | npm `latest`                    | 〃                                         |
| 5   | `@slopus/happy-providers`          | happy-agent                                              | npm `latest`                    | 〃                                         |
| 6   | `@slopus/happy-agent-compute`      | happy-agent                                              | npm `latest`                    | 〃 (keeps its sandbox-proof workflow)      |
| 7   | `@slopus/happy-agent-supervisor`   | happy-agent                                              | npm `latest`                    | 〃                                         |
| 8   | `happy-plugins`                    | happy-agent                                              | npm `latest`                    | 〃                                         |
| 9   | Happy Desktop app (std+nightly)    | [happy-desktop](https://github.com/slopus/happy-desktop) | mac builds + update manifest    | its own cycle; nightly = only preview user |
| 10  | Happy mobile app (`happy-app`)     | [happy](https://github.com/slopus/happy)                 | App Store / Play                | its own cycle                              |
| 11  | Happy sync server (`happy-server`) | happy                                                    | Docker deploy                   | its own cycle                              |

Never published: `@slopus/happy-agent`, `@slopus/happy-agent-modules` —
compiled into the binary. Library rules: exact pins everywhere, publish is
inert until a consumer repins; dependency order providers → base → consumers.

## Version rules

- Product `package.json` holds the next stable version, always unpublished.
- Preview versions derive: `X.Y.Z-preview.N`, N = commits since last stable tag.
- Workflows never push to main; no bot commits.

## The three tiers

```
LOCAL ── any worktree, nothing published, nothing tracked changes
│  pnpm local / pnpm local:off
├─ .local/tarballs/*.tgz                      packed SDKs (gitignored)
├─ .pnpmfile.cjs                              committed, inert: tarballs present
│                                             → resolve from them, else npm
├─ pnpm-lock.yaml                             never written (lockfile off in local mode)
└─ ~/.happy/dist/version/<tree-version>/      self-contained agent binary

PREVIEW ── auto on every push to main, one channel, no canary, no beta
├─ tag v0.4.50-preview.N (GitHub prerelease)
│    happy-agent-0.4.50-preview.N-{darwin,linux}-{arm64,x64}.tar.gz + .sha256
├─ npm: nothing
└─ visible ONLY to Happy Desktop nightly

STABLE ── machine-led, watched end to end
│  1. push bump commit "Start 0.4.51"     ← closes the version window first
│  2. dispatch promote → CI tags the previewed commit (tree already says
│     0.4.50), rebuilds, marks LATEST
│  3. gh run watch → verify assets/npm → report
├─ tag v0.4.50 → releases/latest           preview machines auto-promote
└─ npm: @slopus/happy-terminal@latest      (its own dispatch, same shape)
```

## Desktop's three update loops

```
Happy Desktop machine
├─ the APP     auto-update via hosted manifest      (per desktop release)
├─ the AGENT   GitHub release catalog → download+verify → select → restart
│              (nightly lists prereleases; standard sees latest only)
└─ the CLIENT  exact npm pin, baked in at app build time
```

## Steps

| #   | Step                                                                                                | Done when                                                                     |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Local tier: `pnpm local`/`local:off`, tarball store, inert pnpmfile, tree-version installs          | an SDK change runs in the full local assembly, no publish, `git status` clean |
| 2   | Reconcile SDK chain: publish+repin the client drift on main; encode release order                   | resolved graph holds one copy of each SDK at published pins                   |
| 3   | Preview channel: real versions in manifests, on-push workflow, retention; delete canary + beta      | a push yields an installable prerelease; npm receives nothing                 |
| 4   | Stable: promote mode, bump-then-dispatch flow, rewrite release-agent skill, dictate AGENTS.md edits | a stable ships with no typed version; tagged commit's tree says it            |
| 5   | Gate previews to Desktop nightly                                                                    | a standard Desktop never offers a preview                                     |
