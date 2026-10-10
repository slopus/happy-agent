# Supervisor crate

This library is linked into the sole `happy-agent` executable. Its `supervisor`
subcommand accepts policy JSON through `--policy` or `--policy-file` and a target
argument vector after `--`. It never accepts a command string or chooses a shell.

Linux namespace init and the protected-name FUSE servers are forked library
roles inside that same executable. No separate supervisor binary, mount helper,
or runtime is shipped.
