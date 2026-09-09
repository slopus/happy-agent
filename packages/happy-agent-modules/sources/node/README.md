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
