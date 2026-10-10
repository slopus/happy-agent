# Platform boundaries

Linux establishes namespaces, mounts, seccomp, capability removal, and a
private procfs. macOS builds and installs one Seatbelt profile in-process.
`child.rs` holds the fork, wait, and status reproduction both platforms need
once something has to outlive the workload's `execve`.

`protected_names.rs` adds a supervisor-owned FUSE filesystem over writable
directory views when write denials are present. Linux 6.12's
[`fuse_fs_type`](https://github.com/torvalds/linux/blob/v6.12/fs/fuse/inode.c)
declares `FS_USERNS_MOUNT`; its
[`directory operations`](https://github.com/torvalds/linux/blob/v6.12/fs/fuse/dir.c)
send create, mkdir, mknod, symlink, link, and rename requests to the filesystem
before admitting the operation. Requests use pinned directory nodes and a single
filename, so rejection is atomic and never resumes a mutable workload pathname.
The backend uses pinned directory descriptors and non-following leaf operations.
No watcher participates in enforcement.

```text
happy-agent supervisor
    `-- namespace init (PID 1)
        +-- filesystem servers -> pinned backing directories and deny mounts
        `-- workload -> kernel FUSE requests -> filesystem servers
```

Existing deny mounts stay in the backing view. Protected inode identities cover
hard-link aliases; protected parent identities cannot be moved or replaced.
Every writable directory grant receives the same filter, including bind-mount
aliases. The kernel performs symlink and directory-FD resolution through the
mounted filesystem. Caller directory descriptors are removed at workload exec,
and non-dumpable supervisor/server processes prevent `/proc` from disclosing
their backing handles. No mount helper, separate shipped binary, or runtime is
introduced. Missing FUSE support or an unpinnable protected parent fails closed.

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
