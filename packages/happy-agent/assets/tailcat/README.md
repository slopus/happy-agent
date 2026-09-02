# Tailcat binary assets

Happy Agent embeds Tailcat v0.4.0 for each of its four release targets. Binary integrity is pinned
in `v0.4.0/SHA256SUMS` and checked again by `scripts/resolveTailcatBinaryAsset.ts` before a Happy
Agent standalone binary is compiled.

The Linux x64 and arm64 executables are extracted unchanged from Tailcat's official v0.4.0 release
archives. The downloaded archives were verified against the release's official `checksums.txt`:

- `tailcat_0.4.0_linux_amd64.tar.gz`:
  `8b819c43dfdf806b5663e23535aba557bb106075b0b5839df289af9bba70bec2`
- `tailcat_0.4.0_linux_arm64.tar.gz`:
  `3b77322350f64d229d5b2119b159b863b4bcffa0a62a0294682423a19956dc76`

Tailcat v0.4.0 publishes no macOS artifacts. The Darwin x64 and arm64 executables were built from
Go module `github.com/tailscale/tailcat@v0.4.0` (tag commit
`ce6fedcabc220bab3b94d470ab330219111eeae8`, module sum
`h1:WA8QIBcnn+x7BBmay3mPY+EeOp14RTQr4Qv1Df1GOxU=`) with Go 1.27.0, `CGO_ENABLED=0`, the upstream
`build-tags.txt`, and these release flags:

```text
go build -trimpath -buildvcs=false -tags <upstream-build-tags> \
  -ldflags "-s -w -X main.version=v0.4.0" ./cmd/tailcat
```

The checked-in executables are unsigned. The Happy Agent release workflow signs the selected
Darwin Tailcat executable with Happy's Developer ID before embedding it, then submits both the
exact signed Tailcat and Happy Agent executables to Apple's notary service. The BSD-3-Clause
license is in `LICENSE` and is materialized beside Tailcat at runtime.
