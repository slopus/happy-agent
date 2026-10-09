# Native product learnings

The Rust executable must retain the original Happy Agent commands, flags and defaults. Provider
diagnostics alone did not retain the shipped product. Daemon launch now uses the same executable's
`run` role, and the existing public help text remains the CLI authority.

The runtime's database ownership seam must remain the canonical `<database>.lock` SQLite write
transaction, together with the original agent store's matching-token PID lock. A different sibling
lock lets the old and new runtimes both claim one installation. Opened database handles must close
before releasing ownership. Original migration keys retain their declaration order and are checked
as an exact prefix; unrelated tables and opaque payloads are left in storage until their owning
feature reads them.

The Node inspector does not exist in a Rust process. Both existing inspector routes use the API's
documented 409 response for a daemon without inspector support. The public contract stays unchanged.
