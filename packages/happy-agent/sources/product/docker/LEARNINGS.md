# Native Docker compute learnings

Docker compute uses the selected image and workspace path. Running its files or
commands on the daemon after a container failure would violate that selection.
The Docker owner instead opens a private runner transport to the same Happy Agent
executable inside that container, and failure remains an error.

The container worker is an internal role of the one Cargo executable. A Linux
daemon binds its executable read-only into the container. Other host platforms
still need provisioning of the matching published whole Linux executable; a
different helper binary, JavaScript worker or silently substituted image is not
an acceptable replacement.

Source managed containers admit the inner supervisor with `seccomp=unconfined`,
the configured AppArmor profile (default `unconfined`), and empty masked/read-only
system path arrays. Native managed containers preserve those exact settings;
they never add privileged mode, capabilities, host namespaces, or unrelated
devices. Unlike the former bind-only supervisor, the native supervisor protects
absent names through FUSE. Managed Linux containers therefore expose only the
engine host's FUSE character device (10:229) with read/write device permissions.
Config verifies that identity locally before creation; the Engine must also
provide it in its own host namespace. No client-side check establishes a remote
or virtual machine's device provisioning. The mounted workspace still needs the
native literal-name filesystem checks.
Ubuntu's live proof explicitly selects the same named AppArmor namespace profile
as Source's Docker fixture while its global user-namespace restriction remains
enabled. Only test builds can supply that profile for the image-only agent
fixture; production keeps Source's default `unconfined` profile. This gate does
not establish that the default profile admits restricted shells on that host.
Attaching never mutates that container's outer security. The inner supervisor
still enforces each shell's permissions and must refuse before starting work if
its kernel admission fails, using the startup byte and exit 125 contract.

File review resolves paths in the container. The host keeps the inspected call,
vendor, compute configuration and canonical targets until its tool result
transaction commits. The worker rechecks those targets during the operation, so
a changed symlink cannot reuse an earlier review or temporary Full access. Native
file implementations retain their original read stamps and diff presentations;
the daemon commits those with its owning result rather than keeping knowledge
only in the disposable worker.

The worker initially applied the host runner's home and credential exclusions
inside the image. Docker instead keeps Source's declared paths: image home and
credential files remain readable unless the caller declares them private. The
worker's own runtime state remains private. Ordinary runner requests retain
their original schema and cannot carry Docker-only private policy fields or
enable the internal container role.

Container and worker identities belong to durable ownership records. Cancellation
persists teardown before releasing the lifetime, and daemon startup cleans former
ownership rather than replaying a shell or starting a second worker. A managed
container is removed only after its final owner releases it. An explicitly
attached container remains running; its worker and commands are released and the
Engine confirms that worker has ended.

Secrets are resolved by the existing Secrets owner for the exact selected agent,
project and workspace scopes. Only selected values enter one container shell.
Attached but omitted names and private runner credentials are removed from its
environment; the worker never inherits the daemon's environment.
