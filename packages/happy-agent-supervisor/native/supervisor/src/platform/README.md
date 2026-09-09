# Platform boundaries

Linux establishes namespaces, mounts, seccomp, capability removal, and a
private procfs. macOS builds and installs one Seatbelt profile in-process.
`child.rs` holds the fork, wait, and status reproduction both platforms need
once something has to outlive the workload's `execve`.

Ubuntu AppArmor may transition an unconfined supervisor to `unprivileged_userns (enforce)` only
after `unshare(CLONE_NEWUSER)` succeeds. Namespace setup errors identify the failed operation and,
when that restrictive profile is actually observed, explain the required administrator-owned
application allowance. Bootstrap remains fail-closed; it never changes dumpability ordering,
AppArmor policy, service privileges, or global sysctls to get past a denial.

Linux read denials are canonicalized and reduced to disjoint subtree roots before
mounting. A parent mask already hides every child; trying to mask that child again
would fail after its mount target disappears. Symlink aliases and duplicates converge
to the same root, while component-wise comparisons preserve similarly named siblings.

Both platforms fork the egress process before their boundary exists: on Linux
before `unshare(CLONE_NEWNET)`, on macOS before `sandbox_init`. Ending it differs
for the same reason. The Linux supervisor stays outside the namespace it created
and kills and reaps the process directly; the macOS front-end process is itself
inside the profile, which forbids signalling a process outside its sandbox, so it
closes the link instead — which is what ends the egress loop and, more to the
point, what removes the route out of the jail.
