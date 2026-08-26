# Documentation extraction

This directory owns the installed copy of Happy Agent's documentation. The repository-level
`docs/` directory is copied into the npm package at build time and embedded into standalone Bun
binaries. Daemon startup then synchronizes those shipped files into the configured Happy home.

```text
repository docs/ --> package dist/docs/ --+
                                            +--> <happy home>/docs/
repository docs/ --> standalone binary ----+
```

The destination is managed product documentation. Files are replaced atomically and made
read-only so every daemon start restores the documentation belonging to the running release.
