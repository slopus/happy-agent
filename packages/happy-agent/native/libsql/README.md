# Native database binding

Every standalone agent target embeds a locally built libSQL binding with the connection-disposal and statement/row-lifetime patches in this directory. The source commit, crate checksum, Rust toolchains, and lockfile are pinned here. Supported hosts are macOS and glibc Linux (arm64/x64), and Windows x64; build on the matching host rather than cross-compiling the addon.

From the repository root, run:

```sh
pnpm --filter @slopus/happy-agent build:native:libsql
pnpm --filter @slopus/happy-agent test:native:libsql
```

The build machine needs Rust 1.95.0 through rustup, Git, cp, CMake, the system C/C++ compiler, and make on PATH. Windows specifically uses the pinned GNU Rust toolchain and mingw32-make. Git for Windows supplies cp in its usr/bin directory; a PowerShell alias does not provide an executable to the upstream Rust build script. CMake defaults to the MinGW Makefiles generator only on Windows. These are build dependencies; the distributed Happy Agent does not need them.

HAPPY_LIBSQL_BUILD_DIR optionally selects a fresh build cache. The default cache is separate for each host target. The builder fetches the pinned source, verifies the libSQL crate archive checksum, applies the recorded patches, and compiles with the recorded Cargo.lock. It validates the resulting deterministic-disposal exports before producing native/target/<platform>-<arch>/libsql.node. Standalone builds require this asset and never fall back to npm's upstream binding. The embedded loader checks the exports again at runtime.

Verification copies the client, JavaScript binding, and native addon into an isolated temporary runtime, compares the copied addon with the build's SHA-256, and leaves the installed pnpm dependencies untouched. To deliberately replace the binding in a local development installation, explicitly pass --install-development-binding to scripts/build-native-libsql.mjs. This may overwrite a shared pnpm hardlink; it is not needed for verification and reinstalling dependencies may replace it. The standalone build always uses the separate native/target asset.

The patches preserve the public database API. They make repeated connection teardown safe and release statement/row native state independently of JavaScript garbage collection. The client detaches its native connection for each transaction. Without these exports, completed transactions retain that connection until GC, so a long-running daemon can accumulate thousands of handles and native SQLite caches even when the JavaScript heap is small.

Verification runs the unchanged 3,000-transaction regression in `probe-native-libsql-lifetime.mjs` with completed wrappers retained. On macOS/Linux it records database FDs and RSS every 500 transactions, requires bounded FDs throughout, and requires zero database handles after close, before GC. It then checks another 3,000 ESM transactions with forced GC, statement finalization, exhausted/early-return iterators, immediate file rename, and 10,000 repeated closes. Node and Bun both run these checks.

The Unix release matrix also runs `verify-native-libsql.mjs --upstream` and requires the expected handle-accumulation failure before accepting the patched result. The standalone transport smoke checks that the extracted Unix addon has the exact verified build hash and native exports. Windows continues its native verification lane and embedded export guard. These checks establish SQLite cleanup; they do not claim to fix an unrelated Bun runtime assertion.
