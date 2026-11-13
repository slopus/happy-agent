# Tailcat binary assets

Happy Agent embeds Tailcat v0.7.0-happy.2, Happy's patched build of Tailcat v0.7.0, for each of
its five release targets. Binary integrity is pinned in `v0.7.0-happy.2/SHA256SUMS` and checked
again by `scripts/resolveTailcatBinaryAsset.ts` before a Happy Agent standalone binary is compiled.

## Source

All five executables are built from tag `v0.7.0-happy.2` of Happy's fork,
[slopus/tailcat](https://github.com/slopus/tailcat) (commit
[`de122ebfc8f3ec0cda0f8e72a34b6d6627240896`](https://github.com/slopus/tailcat/commit/de122ebfc8f3ec0cda0f8e72a34b6d6627240896)).
That tag is upstream [tailscale/tailcat](https://github.com/tailscale/tailcat) `v0.7.0` (commit
`15ab9e68bfc6534a61797d7af28cedd42b54a3a5`) plus these commits:

1. [`612a1d156`](https://github.com/slopus/tailcat/commit/612a1d156ccc34fa4f932375bc22a748580b0bd5)
   stops a client that resets its connection right after the handshake from crashing the whole
   server. Netstack then hands the exec handler a connection whose remote address is nil, and
   building the peer environment from it panicked. The handler now closes such a connection, and
   a panic in any one connection's handler is recovered and closes only that connection.
2. [`4e70535e4`](https://github.com/slopus/tailcat/commit/4e70535e4f5e6d757dd6900c9f84f1a2a78f2bbc)
   adds a test that downloads 2 MB between two gVisor stacks over a 70 ms round trip with a 300 ms
   blackout. On upstream's gVisor it stalls for over 30 seconds; with the fix below it finishes in
   about 1.5 seconds.
3. [`0cdfe71ce`](https://github.com/slopus/tailcat/commit/0cdfe71cee5e63e0d053cd5c0189be8683c77c96)
   replaces `gvisor.dev/gvisor` with Happy's fork
   [slopus/gvisor](https://github.com/slopus/gvisor), branch `tailcat-rto-recovery`: the gVisor
   commit upstream v0.7.0 pins (`a6f909f08a7250c080b5b70f3513e8b27b75f64a`) plus
   [`81dfea2b6`](https://github.com/slopus/gvisor/commit/81dfea2b6e59310e06b52216bfbdeae1affc7c5b).
   After a retransmission timeout, RACK used to start a SACK fast recovery that sent nothing until
   the next, doubled, timeout, so a connection whose path dropped briefly repaired one or two
   segments per timeout. RACK no longer starts a recovery during timeout recovery, as RFC 6675
   already requires of the duplicate-ACK path.
4. [`593688625`](https://github.com/slopus/tailcat/commit/593688625db6efd03e9602816029a50b92a54f2d)
   lets clients rejoin at once after the server restarts. A restarted server keeps its key but
   loses its sessions, and it used to drop its clients' packets in silence until their own
   timeouts made them reconnect, 5 to 15 seconds or longer. When something other than a meow
   arrives over DERP from a client it would admit but holds no session for, it now answers with a
   5-byte meow-again packet (`meow` then `0x03`), at most once a second per client. Clients that
   don't know the packet ignore it.
5. A README note describing the fork, which `tailcat readme` prints.

The fork is not an official Tailscale release. Its only protocol addition is the meow-again reply,
which upstream Tailcat clients ignore, so they connect to it unchanged.

## Build

Every executable was built with Go 1.27.1, `CGO_ENABLED=0`, the fork's `build-tags.txt`, and:

```text
GOOS=<os> GOARCH=<arch> go build -trimpath -buildvcs=false -tags "$(cat build-tags.txt)" \
  -ldflags "-s -w -X main.version=v0.7.0-happy.2" ./cmd/tailcat
```

The build is reproducible: a fresh clone of the tag builds the same five hashes, and the same
command run against upstream `v0.7.0` with `main.version=v0.7.0` reproduces the previously
embedded Darwin executables byte for byte. Upstream's official Linux and Windows archives were
built by GoReleaser without `-trimpath` and with VCS stamping, so the fork builds all five targets
with the command above instead.

## Signing and license

The checked-in executables are unsigned. The Happy Agent release workflow signs the selected
Darwin Tailcat executable with Happy's Developer ID before embedding it, then submits both the
exact signed Tailcat and Happy Agent executables to Apple's notary service. Windows release signing
must run before embedding the executable. Tailcat's BSD-3-Clause license is in `LICENSE` and is
materialized beside Tailcat at runtime.
