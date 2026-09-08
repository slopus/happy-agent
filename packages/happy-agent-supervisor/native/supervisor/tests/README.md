# Native behavior tests

`behavior.rs` invokes the real supervisor recursively and verifies output and
exit propagation, filesystem enforcement, seccomp with retained egress, private
procfs visibility, `ps`, zero effective capabilities, and signals.

Its filesystem cases write through a _relative_ path on purpose. Binding a mount
over the working directory leaves an already-standing process pointing at the
shadowed directory underneath, so `/workspace/file` can succeed while `./file`
is refused — and relative is how commands actually write.

`overlapping_read_denials_preserve_the_boundary_in_either_order` proves that a private
directory and its child can both be denied, in either order, without preventing the
workload from starting. It covers Read only, Workspace write, and Auto, verifies the
private file is inaccessible, and keeps a similarly named sibling readable. Linux
coalesces canonical covered subtrees before mounting masks, so an earlier parent mask
never removes a later child's mount target.

Two cases cover process hardening from the outside, which is the only place its
effects are visible. `the_workload_cannot_read_the_supervisor_it_runs_under`
opens `/proc/1/mem` from inside the sandbox: PID 1 there is the supervisor's own
namespace init, running as the same mapped user, so without the non-dumpable
flag that read succeeds. `the_workload_is_given_the_environment_the_caller_wrote`
sets `LD_LIBRARY_PATH` and expects to find it, because hardening removes the
loader variables from the supervisor and the easy mistake is to remove them from
the workload too — the workload can set them for its own children regardless, so
dropping them there would cost ordinary build configuration and buy nothing.

`the_legacy_remount_fallback_enforces_the_same_boundary` forces the pre-5.12
remount path with `HAPPY_AGENT_SUPERVISOR_FORCE_LEGACY_REMOUNT=1`, because every
kernel this is tested on has `mount_setattr` and the fallback would otherwise
never execute anywhere it could be observed. It cannot run as a unit test:
libtest runs each test body on a spawned thread, and `unshare(CLONE_NEWUSER)`
returns `EINVAL` for a process with more than one thread, so it has to drive the
real binary as a subprocess.

`outgoing_proxy.rs` starts an origin server and nothing else: the supervisor
forks its own egress process, binds its own front-ends, and enforces the
command's host list itself. It covers the allowed and denied paths of both
front-ends, an allowlisted name that resolves inward, a missing and a wrong
front-end credential, a transfer larger than one credit window, and the
workload's inability to reach the destination without the proxy.

`the_workload_cannot_reach_the_destination_without_the_proxy` also checks that
the workload holds no descriptor above standard error, and describes rather than
counts: number, kind, whether it would survive `execve`, and for a socket its
domain, its type and both addresses. It counted once, and the count was useless
the first time it mattered. The GitHub macOS runners reported one inherited
socket where both development machines reported none, and a `1` cannot tell the
supervisor's own link to its egress process — an unnamed `AF_UNIX` stream
socketpair — from a socket the runner left open in whatever ran the test.

Those two call for opposite fixes, which is why the report has to name which.
Nothing the supervisor creates should appear: the egress link is a close-on-exec
socketpair, the front-ends are std `TcpListener`s, and the status pipe is
`pipe2(O_CLOEXEC)`. A descriptor the test process is also holding came from the
environment through cargo and libtest, and means this assertion is over-broad and
should narrow to descriptors the supervisor could have created. One the test
process is not holding is the supervisor's own, and should be corrected where it
is created, in the way Codex clears and relocates the single descriptor it means
to pass on. Both lists are printed, and `--nocapture` shows the test process's
own on a passing run too.

`127.0.0.1` appears in those allowed-host lists deliberately. It is the one case
where an address inside the machine may be reached, because the policy named that
literal itself, and it is what lets an origin on loopback stand in for a real
destination. The `localhost` cases are the opposite: the name is allowed and the
address it resolves to is not, which is what the resolved-address check exists
for.

## Running them on Linux from a macOS host

The test binaries bake in absolute paths at compile time, so the repository has
to appear inside the container at the same path it has on the host:

```sh
cargo +1.96.0 test --locked --target aarch64-unknown-linux-musl --no-run
docker run --rm --platform linux/arm64 \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v "$REPO:$REPO" -w "$REPO/packages/happy-agent-supervisor/native" \
  alpine:3.20 "$REPO/.../deps/outgoing_proxy-<hash>" --test-threads=1
```

All three relaxations are needed and none of them weaken what is under test.
Docker's default seccomp profile refuses `unshare(CLONE_NEWUSER)`, its AppArmor
profile refuses the mount work, and its masked `/proc` entries leave procfs
partially covered, which makes mounting a private procfs inside a user
namespace fail. The supervisor installs its own filter and its own mounts once
it is running.

The amd64 lane cannot be run this way. QEMU user emulation does not implement
`prctl(PR_SET_SECCOMP)`, so the supervisor fails closed with `EINVAL` before it
reaches a front-end. That lane needs a real x86_64 kernel.
