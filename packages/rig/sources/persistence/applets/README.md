# Applet persistence

`RigAppletCatalog` is Rig's structural SQL implementation of the catalog port exported by
`@slopus/happy-agent-features`.

The feature owns applet validation, filesystem installation, versioning behavior, idempotency, and
events. This directory only translates its validated catalog operations into Rig's SQLite schema
and validates persisted values on the way back out.
