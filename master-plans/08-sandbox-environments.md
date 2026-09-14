# Master plan 8: sandbox environments

Rig's restricted command modes depend on a small, explicit security environment.
We support the environment well instead of pretending that an incomplete
environment is secure.

Continue using Happy's native supervisor as the sandbox implementation. On
macOS it applies the system Seatbelt boundary; on Linux it owns the required
namespaces, filesystem restrictions, and network isolation directly. This
supersedes the earlier Bubblewrap and `socat` requirement. A Docker image or
existing container used as a Rig execution environment must contain the native
supervisor and allow the nested isolation it needs.

Restricted execution must fail closed with a human-readable explanation when
one of these requirements is missing. Full access does not claim to provide the
restricted sandbox boundary.

Managed HTTP and SOCKS proxy access must work for native commands and
Docker-backed commands under the same project and global network policy. The
proxy is created only for the command and is not published as a generally
available TCP service. The native supervisor owns its isolated front ends and
private link to the egress process. Where a host-to-container bridge requires
shared Unix sockets, their root must be immutable to restricted commands and
connections must require unguessable command-scoped authentication. A neighboring
command must never replace or attach to another command's bridge. A restricted
Docker command must not inherit the container's parent process table or another
command's temporary process-control state. Restricted commands
receive a private `/tmp`. When nested procfs mounting is unavailable, an empty
private `/proc` is the secure fallback.

The repository's root `happy.toml` is part of the sandbox boundary because it can
grant managed network access to later commands. Restricted commands must see it
read-only. When it does not exist, it must remain absent before, during, and
after every restricted command. Rig must never create an empty placeholder or
any other synthetic file at a protected path in order to enforce the sandbox.

Workspace services use a separate tool and a stricter native-supervisor boundary,
without changing ordinary shell commands. Only selected read-only workspace
inputs and required runtime files are exposed. Writable storage is private and
disposable; ambient credentials and control sockets are absent. Network access
is constrained, memory and process limits cover the whole tree, and teardown
must be confirmed before workspace files can be removed. These restrictions
remain mandatory in Full access. A platform that cannot enforce them refuses
service startup rather than falling back to an ordinary shell.

This plan is complete when:

1. startup and command errors clearly identify a missing or unusable sandbox
   dependency;
2. native macOS and Linux restricted commands enforce their configured
   filesystem and network boundaries;
3. a real Docker-backed session can reach an allowed HTTP destination through
   the managed proxy while direct unconfigured network access remains blocked;
4. proxy processes, socket bridges, and temporary directories are removed when
   commands finish or fail;
5. an existing root `happy.toml` remains immutable across concurrent restricted
   commands, and an initially absent one remains absent throughout execution.
