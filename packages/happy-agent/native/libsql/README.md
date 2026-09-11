# Windows native database binding

The standalone Windows agent embeds a locally built libSQL binding with the connection-disposal and statement/row-lifetime patches in this directory. The source commit, crate checksum, Rust toolchain, and lockfile are pinned here.

From the repository root, run:

```powershell
pnpm --filter @slopus/happy-agent build:native:libsql
```

The build machine needs the pinned Rust GNU toolchain, Git, GNU cp, CMake, GCC/G++, and mingw32-make on PATH. Git for Windows supplies cp in its usr/bin directory; a PowerShell alias does not provide an executable to the upstream Rust build script. CMake defaults to the MinGW Makefiles generator. These are build dependencies; the distributed Happy Agent does not need them.

HAPPY_LIBSQL_BUILD_DIR optionally selects a fresh build cache. The builder fetches the pinned source, verifies the libSQL crate archive checksum, applies the recorded patches, and compiles with the recorded Cargo.lock. It validates the resulting deterministic-disposal exports before producing native/target/win32-x64/libsql.node.

To use that same binding in the local pnpm development installation, explicitly pass --install-development-binding to scripts/build-native-libsql.mjs. Reinstalling dependencies may replace that development copy with npm's upstream binding; the standalone build uses the separate native/target asset.

The patches preserve the public database API. They make repeated connection teardown safe and release statement/row native state independently of JavaScript garbage collection. Validation must include transactions, rollback/commit, garbage collection, close, and immediate database-file rename under both Node and Bun.

After installing the development binding, run `pnpm --filter @slopus/happy-agent test:native:libsql`. This verifies the installed/built binary hashes match, then runs 3,000 commit/rollback transactions with garbage collection, immediate file rename after closing, and 10,000 repeated-close probes under each runtime.
