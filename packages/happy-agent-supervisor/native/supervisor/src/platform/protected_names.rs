//! A kernel FUSE boundary for names that have no inode to bind-mount read-only.
//!
//! Requests identify a pinned parent inode and one name. We reject protected
//! namespace mutations before performing any backing syscall. We never resume a
//! syscall using a pathname that another workload thread could change.
use crate::{SupervisorResult, invalid_input};
use fuser::{FileAttr, FileType, Filesystem, Request, TimeOrNow};
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString, OsStr};
use std::fs::{self, File};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Identity = (u64, u64);
type FsResult<T> = Result<T, i32>;
const TTL: Duration = Duration::ZERO;
const MAX_NODES: usize = 65_536;
const MAX_HANDLES: usize = 16_384;
const MAX_PROTECTED_OBJECTS: usize = 1_048_576;
const MAX_WRITE_VIEWS: usize = 64;
const FS_CASEFOLD_FL: libc::c_long = 0x4000_0000;

#[derive(Default)]
pub(super) struct ProtectedNames {
    names: HashSet<(Identity, Vec<u8>)>,
    ancestors: HashSet<Identity>,
    objects: HashSet<Identity>,
    absent_parents: HashMap<Identity, File>,
}

impl ProtectedNames {
    /// An absent parent cannot be pinned. Refuse that policy rather than deny a
    /// broader name, synthesize a directory, or silently omit its protection.
    pub(super) fn resolve(paths: &[PathBuf]) -> SupervisorResult<(Vec<PathBuf>, Self)> {
        let mut existing = Vec::new();
        let mut protected = Self::default();
        let mut paths = paths.to_vec();
        paths.sort();
        let mut covered: Vec<PathBuf> = Vec::new();
        for path in &paths {
            if covered.iter().any(|ancestor| path.starts_with(ancestor)) {
                continue;
            }
            covered.push(path.clone());
            if path == Path::new("/") {
                existing.push(path.clone());
                continue;
            }
            let parent = path
                .parent()
                .ok_or_else(|| invalid_input("protected name has no parent"))?;
            let parent = parent.canonicalize().map_err(|error| invalid_input(format!(
                "the parent of a write-denied path must exist ({}): {error}; no command was started",
                path.display()
            )))?;
            let name = path
                .file_name()
                .ok_or_else(|| invalid_input("protected path has no filename"))?;
            let metadata = fs::metadata(&parent)?;
            if !metadata.is_dir() {
                return Err(
                    invalid_input("the parent of a protected name must be a directory").into(),
                );
            }
            protected
                .names
                .insert(((metadata.dev(), metadata.ino()), name.as_bytes().to_vec()));
            for ancestor in parent.ancestors() {
                let metadata = fs::metadata(ancestor)?;
                protected.ancestors.insert((metadata.dev(), metadata.ino()));
            }
            match path.canonicalize() {
                Ok(path) => {
                    protected.record_objects(&path)?;
                    existing.push(path);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if fs::symlink_metadata(path).is_ok() {
                        return Err(invalid_input(format!(
                            "write-denied symlink has an absent target ({}); no command was started",
                            path.display()
                        )).into());
                    }
                    let identity = (metadata.dev(), metadata.ino());
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        protected.absent_parents.entry(identity)
                    {
                        // Retain the original parent before read masks hide it.
                        // This descriptor only proves kernel naming semantics;
                        // no request uses it to mutate the backing filesystem.
                        let parent = open_path(
                            libc::AT_FDCWD,
                            &cstring(parent.as_os_str())?,
                            libc::O_PATH | libc::O_DIRECTORY,
                        )
                        .map_err(io::Error::from_raw_os_error)?;
                        entry.insert(parent);
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        existing.sort();
        existing.dedup();
        Ok((existing, protected))
    }

    fn record_objects(&mut self, root: &Path) -> SupervisorResult<()> {
        // Record backing identities before mounting, so pre-existing hard-link
        // or directory-mount aliases cannot provide a writable view of Git or
        // configuration. Symlinks inside a denied tree are not followed.
        let mut pending = vec![root.to_path_buf()];
        let mut visited = 0;
        while let Some(path) = pending.pop() {
            visited += 1;
            let metadata = fs::symlink_metadata(&path)?;
            let new_identity = self.objects.insert((metadata.dev(), metadata.ino()));
            if visited > MAX_PROTECTED_OBJECTS
                || self.objects.len() > MAX_PROTECTED_OBJECTS
                || pending.len() > MAX_PROTECTED_OBJECTS
            {
                return Err(invalid_input(
                    "protected filesystem identity limit exceeded; no command was started",
                )
                .into());
            }
            if metadata.is_dir() && new_identity {
                for entry in fs::read_dir(&path)? {
                    if pending.len() >= MAX_PROTECTED_OBJECTS {
                        return Err(invalid_input(
                            "protected filesystem identity limit exceeded; no command was started",
                        )
                        .into());
                    }
                    pending.push(entry?.path());
                }
            }
        }
        Ok(())
    }

    pub(super) fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub(super) fn denies_object(&self, path: &Path) -> SupervisorResult<bool> {
        let metadata = fs::metadata(path)?;
        Ok(self.objects.contains(&(metadata.dev(), metadata.ino())))
    }

    /// All writable directory views use the filter, including explicit grants
    /// that alias a protected parent. Read-only views remain enforced by mounts.
    pub(super) fn mount(self, roots: &[PathBuf]) -> SupervisorResult<Vec<libc::pid_t>> {
        if self.is_empty() {
            return Ok(Vec::new());
        }
        let mut roots: Vec<_> = roots.iter().filter(|root| root.is_dir()).cloned().collect();
        roots.sort();
        let mut views: Vec<PathBuf> = Vec::new();
        for root in roots {
            if views.iter().any(|parent| root.starts_with(parent)) {
                continue;
            }
            views.push(root);
        }
        if views.len() > MAX_WRITE_VIEWS {
            return Err(invalid_input("protected filenames support at most 64 disjoint writable directory views; no command was started").into());
        }
        if views.is_empty() {
            return Ok(Vec::new());
        }
        for parent in self.absent_parents.values() {
            verify_literal_names(parent)?;
        }
        // Every server inherits the same immutable identity set through fork's
        // shared pages. Do not copy a large Git identity set per writable view.
        let protected = Arc::new(self);
        let mut servers = Vec::new();
        for root in views {
            servers.push(mount_one(&root, Arc::clone(&protected))?);
        }
        Ok(servers)
    }
}

fn verify_literal_names(parent: &File) -> SupervisorResult<()> {
    // Name requests cannot describe a backend's arbitrary case folding or
    // Unicode collation. Fail closed instead of treating a differently spelled
    // protected filename as an ordinary name. These Linux filesystems provide
    // literal names; ext-family case folding is additionally checked per parent.
    let mut metadata = unsafe { std::mem::zeroed::<libc::statfs>() };
    super::linux::syscall_zero("inspect the protected parent filesystem", unsafe {
        libc::fstatfs(parent.as_raw_fd(), &mut metadata)
    })?;
    match metadata.f_type {
        libc::TMPFS_MAGIC | 0x8584_58f6 => return Ok(()), // tmpfs and ramfs
        0xef53 | libc::XFS_SUPER_MAGIC | libc::BTRFS_SUPER_MAGIC => {},
        _ => return Err(invalid_input("absent protected filenames require ext-family, XFS, Btrfs, tmpfs, or ramfs backing directories with literal filename semantics; this filesystem is unsupported and no command was started").into()),
    }
    let directory = open_path(libc::AT_FDCWD, &fd_path(parent.as_raw_fd()), libc::O_RDONLY | libc::O_DIRECTORY)
        .map_err(|error| invalid_input(format!("the protected parent must be readable to verify its filename semantics: {}; no command was started", io::Error::from_raw_os_error(error))))?;
    let mut flags: libc::c_long = 0;
    super::linux::syscall_zero("verify protected parent filename semantics", unsafe {
        libc::ioctl(directory.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags)
    })?;
    if flags & FS_CASEFOLD_FL != 0 {
        return Err(invalid_input("absent protected filenames cannot be enforced on a directory with case folding enabled; no command was started").into());
    }
    Ok(())
}

fn mount_one(root: &Path, protected: Arc<ProtectedNames>) -> SupervisorResult<libc::pid_t> {
    let backing = open_path(
        libc::AT_FDCWD,
        &cstring(root.as_os_str())?,
        libc::O_PATH | libc::O_DIRECTORY,
    )
    .map_err(io::Error::from_raw_os_error)?;
    let filesystem =
        NameFilesystem::new(backing, protected).map_err(io::Error::from_raw_os_error)?;
    let device = File::options().read(true).write(true).open("/dev/fuse").map_err(|error| io::Error::other(format!(
        "absent protected filenames require an accessible /dev/fuse and user-namespace FUSE mounts: {error}; no command was started"
    )))?;
    let target = cstring(root.as_os_str())?;
    let options = CString::new(format!(
        "fd={},rootmode=40000,user_id=0,group_id=0,default_permissions,max_read=131072",
        device.as_raw_fd()
    ))?;
    super::linux::syscall_zero(
        "mount atomic protected-name filesystem (requires user-namespace FUSE support)",
        unsafe {
            libc::mount(
                c"happy-protected-names".as_ptr(),
                target.as_ptr(),
                c"fuse".as_ptr(),
                (libc::MS_NOSUID | libc::MS_NODEV) as libc::c_ulong,
                options.as_ptr().cast(),
            )
        },
    )?;
    let owner = unsafe { libc::getpid() };
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if child == 0 {
        // Namespace PID 1 owns and reaps this server. Its death kills the
        // complete tree; it treats unexpected server exit as a boundary failure.
        let result = (|| -> SupervisorResult<()> {
            super::linux::syscall_zero("watch protected-name filesystem owner", unsafe {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0)
            })?;
            if unsafe { libc::getppid() } != owner {
                return Err(invalid_input("filesystem owner exited").into());
            }
            super::linux::syscall_zero("name protected filesystem process", unsafe {
                libc::prctl(libc::PR_SET_NAME, c"happy-name-fs".as_ptr(), 0, 0, 0)
            })?;
            crate::hardening::apply()?;
            super::linux::drop_all_capabilities_and_lock_privileges()?;
            let fd: OwnedFd = device.into();
            fuser::Session::from_fd(filesystem, fd, fuser::SessionACL::Owner).run()?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Happy Agent supervisor: protected-name filesystem failed: {error}");
        }
        unsafe { libc::_exit(125) }
    }
    Ok(child)
}

struct Node {
    file: File,
    identity: Identity,
    lookups: u64,
    read_only: bool,
}

struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

struct NameFilesystem {
    protected: Arc<ProtectedNames>,
    nodes: HashMap<u64, Node>,
    identities: HashMap<Identity, u64>,
    files: HashMap<u64, File>,
    directories: HashMap<u64, Directory>,
    next_node: u64,
    next_handle: u64,
}

impl NameFilesystem {
    fn new(root: File, protected: Arc<ProtectedNames>) -> FsResult<Self> {
        let metadata = root.metadata().map_err(errno)?;
        let identity = (metadata.dev(), metadata.ino());
        let read_only = protected.objects.contains(&identity);
        Ok(Self {
            protected,
            nodes: HashMap::from([(
                1,
                Node {
                    file: root,
                    identity,
                    lookups: 1,
                    read_only,
                },
            )]),
            identities: HashMap::from([(identity, 1)]),
            files: HashMap::new(),
            directories: HashMap::new(),
            next_node: 2,
            next_handle: 1,
        })
    }

    fn node(&self, ino: u64) -> FsResult<&Node> {
        self.nodes.get(&ino).ok_or(libc::ESTALE)
    }
    fn file(&self, fh: u64) -> FsResult<&File> {
        self.files.get(&fh).ok_or(libc::EBADF)
    }
    fn handle(&mut self, file: File) -> FsResult<u64> {
        if self.files.len() + self.directories.len() >= MAX_HANDLES {
            return Err(libc::EMFILE);
        }
        let id = self.next_handle;
        self.next_handle = id.checked_add(1).ok_or(libc::EOVERFLOW)?;
        self.files.insert(id, file);
        Ok(id)
    }
    fn slot_denied(&self, parent: u64, name: &OsStr) -> FsResult<bool> {
        let node = self.node(parent)?;
        Ok(node.read_only
            || self
                .protected
                .names
                .contains(&(node.identity, name.as_bytes().to_vec())))
    }
    fn writable_slot(&self, parent: u64, name: &OsStr) -> FsResult<CString> {
        if self.slot_denied(parent, name)? {
            return Err(libc::EROFS);
        }
        leaf(name)
    }
    fn movable_slot(&self, parent: u64, name: &OsStr) -> FsResult<CString> {
        let name = self.writable_slot(parent, name)?;
        match open_path(
            self.node(parent)?.file.as_raw_fd(),
            &name,
            libc::O_PATH | libc::O_NOFOLLOW,
        ) {
            Ok(file) => {
                let metadata = file.metadata().map_err(errno)?;
                let identity = (metadata.dev(), metadata.ino());
                if self.protected.objects.contains(&identity)
                    || (metadata.is_dir() && self.protected.ancestors.contains(&identity))
                {
                    return Err(libc::EBUSY);
                }
            }
            Err(libc::ENOENT) => {}
            Err(error) => return Err(error),
        }
        Ok(name)
    }
    fn writable_node(&self, ino: u64) -> FsResult<&Node> {
        let node = self.node(ino)?;
        if node.read_only {
            return Err(libc::EROFS);
        }
        Ok(node)
    }
    fn lookup_entry(&mut self, parent: u64, name: &OsStr) -> FsResult<FileAttr> {
        let mut read_only = self.slot_denied(parent, name)?;
        let file = open_path(
            self.node(parent)?.file.as_raw_fd(),
            &leaf(name)?,
            libc::O_PATH | libc::O_NOFOLLOW,
        )?;
        let metadata = file.metadata().map_err(errno)?;
        let identity = (metadata.dev(), metadata.ino());
        read_only |= self.protected.objects.contains(&identity);
        let ino = if let Some(ino) = self.identities.get(&identity).copied() {
            let node = self.nodes.get_mut(&ino).ok_or(libc::ESTALE)?;
            node.lookups = node.lookups.checked_add(1).ok_or(libc::EOVERFLOW)?;
            node.read_only |= read_only;
            ino
        } else {
            if self.nodes.len() >= MAX_NODES {
                return Err(libc::EMFILE);
            }
            let ino = self.next_node;
            self.next_node = ino.checked_add(1).ok_or(libc::EOVERFLOW)?;
            self.nodes.insert(
                ino,
                Node {
                    file,
                    identity,
                    lookups: 1,
                    read_only,
                },
            );
            self.identities.insert(identity, ino);
            ino
        };
        attributes(ino, &metadata)
    }
    fn reopen(&self, ino: u64, flags: i32) -> FsResult<File> {
        let node = if flags & libc::O_ACCMODE != libc::O_RDONLY || flags & libc::O_TRUNC != 0 {
            self.writable_node(ino)?
        } else {
            self.node(ino)?
        };
        if node
            .file
            .metadata()
            .map_err(errno)?
            .file_type()
            .is_symlink()
        {
            return Err(libc::ELOOP);
        }
        open_path(
            libc::AT_FDCWD,
            &fd_path(node.file.as_raw_fd()),
            flags & !(libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW),
        )
    }
    fn remove(&self, parent: u64, name: &OsStr, flags: i32) -> FsResult<()> {
        let name = self.movable_slot(parent, name)?;
        zero(unsafe { libc::unlinkat(self.node(parent)?.file.as_raw_fd(), name.as_ptr(), flags) })
    }
    fn stat(&self, ino: u64) -> FsResult<FileAttr> {
        attributes(ino, &self.node(ino)?.file.metadata().map_err(errno)?)
    }
    fn attribute_path(&self, ino: u64, writable: bool) -> FsResult<CString> {
        let node = if writable {
            self.writable_node(ino)?
        } else {
            self.node(ino)?
        };
        if node
            .file
            .metadata()
            .map_err(errno)?
            .file_type()
            .is_symlink()
        {
            return Err(libc::EOPNOTSUPP);
        }
        Ok(fd_path(node.file.as_raw_fd()))
    }
}

impl Filesystem for NameFilesystem {
    fn init(&mut self, _: &Request<'_>, config: &mut fuser::KernelConfig) -> FsResult<()> {
        // No writeback cache: every writable admission passes through the server,
        // while zero TTLs preserve visibility of trusted host edits.
        config
            .add_capabilities(fuser::consts::FUSE_AUTO_INVAL_DATA)
            .map_err(|_| libc::EOPNOTSUPP)?;
        config.set_max_write(131_072).map_err(|_| libc::EINVAL)?;
        Ok(())
    }
    fn lookup(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEntry) {
        match self.lookup_entry(parent, name) {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(error) => reply.error(error),
        }
    }
    fn forget(&mut self, _: &Request<'_>, ino: u64, nlookup: u64) {
        if ino == 1 {
            return;
        }
        if let Some(node) = self.nodes.get_mut(&ino) {
            node.lookups = node.lookups.saturating_sub(nlookup);
            if node.lookups == 0 {
                self.identities.remove(&node.identity);
                self.nodes.remove(&ino);
            }
        }
    }
    fn getattr(&mut self, _: &Request<'_>, ino: u64, _: Option<u64>, reply: fuser::ReplyAttr) {
        match self.stat(ino) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(error) => reply.error(error),
        }
    }
    fn setattr(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        _: Option<SystemTime>,
        fh: Option<u64>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
        flags: Option<u32>,
        reply: fuser::ReplyAttr,
    ) {
        let result = (|| {
            let node = self.writable_node(ino)?;
            if flags.is_some() {
                return Err(libc::EOPNOTSUPP);
            }
            let path = fd_path(node.file.as_raw_fd());
            if let Some(mode) = mode {
                if node
                    .file
                    .metadata()
                    .map_err(errno)?
                    .file_type()
                    .is_symlink()
                {
                    return Err(libc::EOPNOTSUPP);
                }
                zero(unsafe { libc::chmod(path.as_ptr(), mode) })?;
            }
            if uid.is_some() || gid.is_some() {
                zero(unsafe {
                    libc::fchownat(
                        node.file.as_raw_fd(),
                        c"".as_ptr(),
                        uid.unwrap_or(u32::MAX),
                        gid.unwrap_or(u32::MAX),
                        libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
                    )
                })?;
            }
            if let Some(size) = size {
                let size = i64::try_from(size).map_err(|_| libc::EFBIG)?;
                if let Some(fh) = fh {
                    zero(unsafe { libc::ftruncate(self.file(fh)?.as_raw_fd(), size) })?;
                } else {
                    zero(unsafe {
                        libc::ftruncate(self.reopen(ino, libc::O_WRONLY)?.as_raw_fd(), size)
                    })?;
                }
            }
            if atime.is_some() || mtime.is_some() {
                let times = [timestamp(atime)?, timestamp(mtime)?];
                zero(unsafe {
                    libc::utimensat(
                        node.file.as_raw_fd(),
                        c"".as_ptr(),
                        times.as_ptr(),
                        libc::AT_EMPTY_PATH | libc::AT_SYMLINK_NOFOLLOW,
                    )
                })?;
            }
            self.stat(ino)
        })();
        match result {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(error) => reply.error(error),
        }
    }
    fn readlink(&mut self, _: &Request<'_>, ino: u64, reply: fuser::ReplyData) {
        let result = (|| {
            let mut bytes = vec![0; 4096];
            let length = unsafe {
                libc::readlinkat(
                    self.node(ino)?.file.as_raw_fd(),
                    c"".as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if length < 0 {
                return Err(last_errno());
            }
            bytes.truncate(length as usize);
            Ok(bytes)
        })();
        match result {
            Ok(data) => reply.data(&data),
            Err(error) => reply.error(error),
        }
    }
    fn mknod(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        rdev: u32,
        reply: fuser::ReplyEntry,
    ) {
        let result = (|| {
            let name_c = self.writable_slot(parent, name)?;
            zero(unsafe {
                libc::mknodat(
                    self.node(parent)?.file.as_raw_fd(),
                    name_c.as_ptr(),
                    mode & !umask,
                    rdev as libc::dev_t,
                )
            })?;
            self.lookup_entry(parent, name)
        })();
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(error) => reply.error(error),
        }
    }
    fn mkdir(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: fuser::ReplyEntry,
    ) {
        let result = (|| {
            let name_c = self.writable_slot(parent, name)?;
            zero(unsafe {
                libc::mkdirat(
                    self.node(parent)?.file.as_raw_fd(),
                    name_c.as_ptr(),
                    mode & !umask,
                )
            })?;
            self.lookup_entry(parent, name)
        })();
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(error) => reply.error(error),
        }
    }
    fn unlink(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        empty(reply, self.remove(parent, name, 0));
    }
    fn rmdir(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        empty(reply, self.remove(parent, name, libc::AT_REMOVEDIR));
    }
    fn symlink(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        target: &Path,
        reply: fuser::ReplyEntry,
    ) {
        let result = (|| {
            let name_c = self.writable_slot(parent, name)?;
            let target = cstring(target.as_os_str()).map_err(errno)?;
            zero(unsafe {
                libc::symlinkat(
                    target.as_ptr(),
                    self.node(parent)?.file.as_raw_fd(),
                    name_c.as_ptr(),
                )
            })?;
            self.lookup_entry(parent, name)
        })();
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(error) => reply.error(error),
        }
    }
    fn rename(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        newparent: u64,
        newname: &OsStr,
        flags: u32,
        reply: fuser::ReplyEmpty,
    ) {
        let result = (|| {
            let source = self.movable_slot(parent, name)?;
            let target = self.movable_slot(newparent, newname)?;
            zero(unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    self.node(parent)?.file.as_raw_fd(),
                    source.as_ptr(),
                    self.node(newparent)?.file.as_raw_fd(),
                    target.as_ptr(),
                    flags,
                ) as i32
            })
        })();
        empty(reply, result);
    }
    fn link(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        parent: u64,
        name: &OsStr,
        reply: fuser::ReplyEntry,
    ) {
        let result = (|| {
            let name_c = self.writable_slot(parent, name)?;
            let source = fd_path(self.writable_node(ino)?.file.as_raw_fd());
            zero(unsafe {
                libc::linkat(
                    libc::AT_FDCWD,
                    source.as_ptr(),
                    self.node(parent)?.file.as_raw_fd(),
                    name_c.as_ptr(),
                    libc::AT_SYMLINK_FOLLOW,
                )
            })?;
            self.lookup_entry(parent, name)
        })();
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, 0),
            Err(error) => reply.error(error),
        }
    }
    fn open(&mut self, _: &Request<'_>, ino: u64, flags: i32, reply: fuser::ReplyOpen) {
        let result = self.reopen(ino, flags).and_then(|file| self.handle(file));
        match result {
            Ok(fh) => reply.opened(fh, 0),
            Err(error) => reply.error(error),
        }
    }
    fn create(
        &mut self,
        _: &Request<'_>,
        parent: u64,
        name: &OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: fuser::ReplyCreate,
    ) {
        let result = (|| {
            let name_c = self.writable_slot(parent, name)?;
            // A backing symlink inserted by the host cannot redirect the final
            // creation. Kernel pathname resolution deals with symlinks via lookup.
            let fd = unsafe {
                libc::openat(
                    self.node(parent)?.file.as_raw_fd(),
                    name_c.as_ptr(),
                    flags | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                    mode & !umask,
                )
            };
            if fd < 0 {
                return Err(last_errno());
            }
            let file = unsafe { File::from_raw_fd(fd) };
            let attr = self.lookup_entry(parent, name)?;
            let fh = self.handle(file)?;
            Ok((attr, fh))
        })();
        match result {
            Ok((attr, fh)) => reply.created(&TTL, &attr, 0, fh, 0),
            Err(error) => reply.error(error),
        }
    }
    fn read(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _: i32,
        _: Option<u64>,
        reply: fuser::ReplyData,
    ) {
        let result = (|| {
            let mut data = vec![
                0;
                usize::try_from(size)
                    .map_err(|_| libc::EINVAL)?
                    .min(131_072)
            ];
            let length = self
                .file(fh)?
                .read_at(&mut data, u64::try_from(offset).map_err(|_| libc::EINVAL)?)
                .map_err(errno)?;
            data.truncate(length);
            Ok(data)
        })();
        match result {
            Ok(data) => reply.data(&data),
            Err(error) => reply.error(error),
        }
    }
    fn write(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        data: &[u8],
        _: u32,
        _: i32,
        _: Option<u64>,
        reply: fuser::ReplyWrite,
    ) {
        let result = (|| {
            self.writable_node(ino)?;
            self.file(fh)?
                .write_at(data, u64::try_from(offset).map_err(|_| libc::EINVAL)?)
                .map_err(errno)
        })();
        match result {
            Ok(length) => reply.written(length as u32),
            Err(error) => reply.error(error),
        }
    }
    fn flush(&mut self, _: &Request<'_>, _: u64, fh: u64, _: u64, reply: fuser::ReplyEmpty) {
        empty(reply, self.file(fh).map(|_| ()));
    }
    fn release(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        _: i32,
        _: Option<u64>,
        _: bool,
        reply: fuser::ReplyEmpty,
    ) {
        self.files.remove(&fh);
        reply.ok();
    }
    fn fsync(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        datasync: bool,
        reply: fuser::ReplyEmpty,
    ) {
        empty(
            reply,
            self.file(fh).and_then(|file| {
                if datasync {
                    file.sync_data()
                } else {
                    file.sync_all()
                }
                .map_err(errno)
            }),
        );
    }
    fn opendir(&mut self, _: &Request<'_>, ino: u64, flags: i32, reply: fuser::ReplyOpen) {
        let result = (|| {
            if self.files.len() + self.directories.len() >= MAX_HANDLES {
                return Err(libc::EMFILE);
            }
            let file = self.reopen(ino, flags | libc::O_DIRECTORY)?;
            let duplicate = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
            if duplicate < 0 {
                return Err(last_errno());
            }
            let dir = unsafe { libc::fdopendir(duplicate) };
            if dir.is_null() {
                unsafe {
                    libc::close(duplicate);
                }
                return Err(last_errno());
            }
            let fh = self.next_handle;
            self.next_handle = fh.checked_add(1).ok_or(libc::EOVERFLOW)?;
            self.directories.insert(fh, Directory(dir));
            Ok(fh)
        })();
        match result {
            Ok(fh) => reply.opened(fh, 0),
            Err(error) => reply.error(error),
        }
    }
    fn readdir(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        offset: i64,
        mut reply: fuser::ReplyDirectory,
    ) {
        let Some(directory) = self.directories.get(&fh) else {
            reply.error(libc::EBADF);
            return;
        };
        unsafe {
            libc::seekdir(directory.0, offset as libc::c_long);
        }
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                let error = last_errno();
                if error != 0 {
                    reply.error(error);
                } else {
                    reply.ok();
                }
                return;
            }
            let entry = unsafe { &*entry };
            let name = unsafe { CStr::from_ptr(entry.d_name.as_ptr()) };
            let kind = match entry.d_type {
                libc::DT_DIR => FileType::Directory,
                libc::DT_LNK => FileType::Symlink,
                libc::DT_FIFO => FileType::NamedPipe,
                libc::DT_SOCK => FileType::Socket,
                libc::DT_CHR => FileType::CharDevice,
                libc::DT_BLK => FileType::BlockDevice,
                _ => FileType::RegularFile,
            };
            if reply.add(
                entry.d_ino,
                entry.d_off,
                kind,
                OsStr::from_bytes(name.to_bytes()),
            ) {
                reply.ok();
                return;
            }
        }
    }
    fn releasedir(&mut self, _: &Request<'_>, _: u64, fh: u64, _: i32, reply: fuser::ReplyEmpty) {
        self.directories.remove(&fh);
        reply.ok();
    }
    fn fsyncdir(&mut self, _: &Request<'_>, _: u64, fh: u64, _: bool, reply: fuser::ReplyEmpty) {
        empty(
            reply,
            self.directories
                .get(&fh)
                .ok_or(libc::EBADF)
                .and_then(|directory| zero(unsafe { libc::fsync(libc::dirfd(directory.0)) })),
        );
    }
    fn statfs(&mut self, _: &Request<'_>, _: u64, reply: fuser::ReplyStatfs) {
        let mut stat = unsafe { std::mem::zeroed::<libc::statvfs>() };
        let result = self
            .node(1)
            .and_then(|node| zero(unsafe { libc::fstatvfs(node.file.as_raw_fd(), &mut stat) }));
        match result {
            Ok(()) => reply.statfs(
                stat.f_blocks,
                stat.f_bfree,
                stat.f_bavail,
                stat.f_files,
                stat.f_ffree,
                stat.f_bsize as u32,
                stat.f_namemax as u32,
                stat.f_frsize as u32,
            ),
            Err(error) => reply.error(error),
        }
    }
    fn setxattr(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        name: &OsStr,
        value: &[u8],
        flags: i32,
        position: u32,
        reply: fuser::ReplyEmpty,
    ) {
        let result = (|| {
            if position != 0 {
                return Err(libc::EINVAL);
            }
            let path = self.attribute_path(ino, true)?;
            let name = cstring(name).map_err(errno)?;
            zero(unsafe {
                libc::setxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    flags,
                )
            })
        })();
        empty(reply, result);
    }
    fn getxattr(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        name: &OsStr,
        size: u32,
        reply: fuser::ReplyXattr,
    ) {
        let result = (|| {
            let path = self.attribute_path(ino, false)?;
            let name = cstring(name).map_err(errno)?;
            let mut data = vec![0; (size as usize).min(65_536)];
            let length = unsafe {
                libc::getxattr(
                    path.as_ptr(),
                    name.as_ptr(),
                    data.as_mut_ptr().cast(),
                    data.len(),
                )
            };
            if length < 0 {
                return Err(last_errno());
            }
            data.truncate(length as usize);
            Ok((data, length as u32))
        })();
        match result {
            Ok((_, length)) if size == 0 => reply.size(length),
            Ok((data, _)) => reply.data(&data),
            Err(error) => reply.error(error),
        }
    }
    fn listxattr(&mut self, _: &Request<'_>, ino: u64, size: u32, reply: fuser::ReplyXattr) {
        let result = (|| {
            let path = self.attribute_path(ino, false)?;
            let mut data = vec![0; (size as usize).min(65_536)];
            let length =
                unsafe { libc::listxattr(path.as_ptr(), data.as_mut_ptr().cast(), data.len()) };
            if length < 0 {
                return Err(last_errno());
            }
            data.truncate(length as usize);
            Ok((data, length as u32))
        })();
        match result {
            Ok((_, length)) if size == 0 => reply.size(length),
            Ok((data, _)) => reply.data(&data),
            Err(error) => reply.error(error),
        }
    }
    fn removexattr(&mut self, _: &Request<'_>, ino: u64, name: &OsStr, reply: fuser::ReplyEmpty) {
        let result = (|| {
            let path = self.attribute_path(ino, true)?;
            let name = cstring(name).map_err(errno)?;
            zero(unsafe { libc::removexattr(path.as_ptr(), name.as_ptr()) })
        })();
        empty(reply, result);
    }
    fn fallocate(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        length: i64,
        mode: i32,
        reply: fuser::ReplyEmpty,
    ) {
        empty(
            reply,
            self.writable_node(ino)
                .and_then(|_| self.file(fh))
                .and_then(|file| {
                    zero(unsafe { libc::fallocate(file.as_raw_fd(), mode, offset, length) })
                }),
        );
    }
    fn lseek(
        &mut self,
        _: &Request<'_>,
        _: u64,
        fh: u64,
        offset: i64,
        whence: i32,
        reply: fuser::ReplyLseek,
    ) {
        let result = self.file(fh).and_then(|file| {
            let offset = unsafe { libc::lseek(file.as_raw_fd(), offset, whence) };
            if offset < 0 {
                Err(last_errno())
            } else {
                Ok(offset)
            }
        });
        match result {
            Ok(offset) => reply.offset(offset),
            Err(error) => reply.error(error),
        }
    }
}

fn attributes(ino: u64, metadata: &fs::Metadata) -> FsResult<FileAttr> {
    let kind = match metadata.mode() & libc::S_IFMT {
        libc::S_IFDIR => FileType::Directory,
        libc::S_IFREG => FileType::RegularFile,
        libc::S_IFLNK => FileType::Symlink,
        libc::S_IFIFO => FileType::NamedPipe,
        libc::S_IFSOCK => FileType::Socket,
        libc::S_IFCHR => FileType::CharDevice,
        libc::S_IFBLK => FileType::BlockDevice,
        _ => return Err(libc::EIO),
    };
    Ok(FileAttr {
        ino,
        size: metadata.size(),
        blocks: metadata.blocks(),
        atime: metadata.accessed().map_err(errno)?,
        mtime: metadata.modified().map_err(errno)?,
        ctime: system_time(metadata.ctime(), metadata.ctime_nsec()),
        crtime: UNIX_EPOCH,
        kind,
        perm: (metadata.mode() & 0o7777) as u16,
        nlink: metadata.nlink() as u32,
        uid: metadata.uid(),
        gid: metadata.gid(),
        rdev: metadata.rdev() as u32,
        blksize: metadata.blksize() as u32,
        flags: 0,
    })
}
fn system_time(seconds: i64, nanos: i64) -> SystemTime {
    if seconds >= 0 {
        UNIX_EPOCH + Duration::new(seconds as u64, nanos as u32)
    } else {
        UNIX_EPOCH - Duration::from_secs(seconds.unsigned_abs())
            + Duration::from_nanos(nanos as u64)
    }
}
fn timestamp(time: Option<TimeOrNow>) -> FsResult<libc::timespec> {
    match time {
        None => Ok(libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_OMIT,
        }),
        Some(TimeOrNow::Now) => Ok(libc::timespec {
            tv_sec: 0,
            tv_nsec: libc::UTIME_NOW,
        }),
        Some(TimeOrNow::SpecificTime(time)) => {
            let duration = time.duration_since(UNIX_EPOCH).map_err(|_| libc::EINVAL)?;
            Ok(libc::timespec {
                tv_sec: i64::try_from(duration.as_secs()).map_err(|_| libc::EINVAL)?,
                tv_nsec: duration.subsec_nanos() as i64,
            })
        }
    }
}
fn leaf(name: &OsStr) -> FsResult<CString> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(libc::EINVAL);
    }
    CString::new(bytes).map_err(|_| libc::EINVAL)
}
fn cstring(path: &OsStr) -> io::Result<CString> {
    CString::new(path.as_bytes()).map_err(|_| invalid_input("path contains a NUL byte"))
}
fn fd_path(fd: RawFd) -> CString {
    // The literal and a decimal integer contain no NUL bytes.
    unsafe { CString::from_vec_unchecked(format!("/proc/self/fd/{fd}").into_bytes()) }
}
fn open_path(parent: RawFd, name: &CStr, flags: i32) -> FsResult<File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags | libc::O_CLOEXEC) };
    if fd < 0 {
        Err(last_errno())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn errno(error: io::Error) -> i32 {
    error.raw_os_error().unwrap_or(libc::EIO)
}
fn last_errno() -> i32 {
    io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}
fn zero(result: i32) -> FsResult<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(last_errno())
    }
}
fn empty(reply: fuser::ReplyEmpty, result: FsResult<()>) {
    match result {
        Ok(()) => reply.ok(),
        Err(error) => reply.error(error),
    }
}
