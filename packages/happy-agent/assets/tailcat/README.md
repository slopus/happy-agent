# Tailcat binary assets

Happy Agent embeds Tailcat v0.7.0 for each of its five release targets. Binary integrity is pinned
in `v0.7.0/SHA256SUMS` and checked again by `scripts/resolveTailcatBinaryAsset.ts` before a Happy
Agent standalone binary is compiled. No target carries a Happy-specific patch.

The Linux x64 and arm64 executables are extracted unchanged from Tailcat's official v0.7.0 release
archives. The downloaded archives were verified against the release's official `checksums.txt`:

- `tailcat_0.7.0_linux_amd64.tar.gz`:
  `23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6`
- `tailcat_0.7.0_linux_arm64.tar.gz`:
  `bbb1ab50f24f00effe1e1fd86d0501803fb80793a90785a2a16ff3428f03d8ef`

Tailcat v0.7.0 publishes no macOS artifacts. The Darwin x64 and arm64 executables were built from
Go module `github.com/tailscale/tailcat@v0.7.0` (tag commit
`15ab9e68bfc6534a61797d7af28cedd42b54a3a5`, module sum
`h1:iMNaCvDAUZ3LKZh0nEDGCVSHWTjbpSdzdYv8g2nvZQI=`) with Go 1.27.1, `CGO_ENABLED=0`, the upstream
`build-tags.txt`, and these release flags:

```text
go build -trimpath -buildvcs=false -tags <upstream-build-tags> \
  -ldflags "-s -w -X main.version=v0.7.0" ./cmd/tailcat
```

The official Linux and Windows binaries were built from the same commit with the same Go version,
tags, and linker flags. Building the Darwin arm64 executable a second time from a Git checkout of
the tag produced byte-identical output.

The checked-in executables are unsigned. The Happy Agent release workflow signs the selected
Darwin Tailcat executable with Happy's Developer ID before embedding it, then submits both the
exact signed Tailcat and Happy Agent executables to Apple's notary service. The BSD-3-Clause
license is in `LICENSE` and is materialized beside Tailcat at runtime.

The Windows x64 executable is extracted unchanged from the official
`tailcat_0.7.0_windows_amd64.zip`, verified against archive SHA-256
`f04cac07e3bf6c700b0b543df0d3315a3b312cd5a05ee76714e1cc848e9b2dff` from the same
`checksums.txt`. Its executable hash is recorded in `v0.7.0/SHA256SUMS`. Windows release signing
must run before embedding the executable.
