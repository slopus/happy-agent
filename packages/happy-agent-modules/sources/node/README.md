# Node configuration

The installation's own name and nullable avatar appear at `config.node`, independently of P2P,
bots, and human profiles. Active admin bots receive name and image-setting tools; all file reads
use Compute's shared per-action permissions, including outside-workspace and symlink review.

```text
HTTP name patch / admin tools -> node singleton transaction -> config.updated
                                       |
                                       +-> Durable Functions -> generated runtime.toml name
```

One bounded database record stores the current name and normalized avatar bytes with their
ThumbHash and content ETag. Name and avatar updates compose with caller transactions; notifications
publish only after commit. Image replacement is atomic, identical normalized images are no-ops,
and no historical image collection accumulates. Runtime configuration writes are durable work
that reads the latest name, never an old name captured in an earlier call.

The singleton is seeded once, when a fresh database has no node row. Its name is configured
`[node] name` or the detected machine name (the friendly macOS ComputerName, then the hostname).
On macOS it also best-effort adopts the current account picture from directory services: the
cropped `JPEGPhoto`, then the `Picture` file, with HEIC and TIFF converted by `sips` in a
temporary directory. Detection and normalization run before the seeding transaction with bounded
commands; any failure leaves the avatar `null`. Later starts never run detection or replace an
existing name or avatar.
