# Native Windows file-index library

FFF's upstream 0.9.6 Windows library requires VCRUNTIME140.dll. Happy builds the
same pinned C API with the Windows GNU toolchain and upstream's default globset
matcher. The optional Zig/zlob optimization is not enabled. No source patch or
API replacement is required. The build rejects external DLL imports and embeds
the result plus its MIT license only in the Windows standalone artifact.

Run `pnpm --filter @slopus/happy-agent build:native:fff` with the recorded Rust
toolchain and GNU C compiler available. `HAPPY_FFF_SOURCE_DIR` can reuse a clean
checkout of the pinned commit. The upstream Cargo.lock is used with `--locked`.
The output is `native/target/win32-x64/fff_c.dll`.

Run `pnpm --filter @slopus/happy-agent test:native:fff` to exercise the installed
JavaScript SDK against this exact library under Node and Bun in isolated fixtures.
It covers scanning, Unicode filenames, fuzzy search, globbing, grep, changes and
handle cleanup. Only the fixture's binary resolver changes; node_modules and the
running daemon are untouched. macOS/Linux continue using their upstream assets.
