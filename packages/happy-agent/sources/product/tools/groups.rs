//! Known-owned process groups survive a normal shell exit until explicit cleanup.
use anyhow::{Context, Result};
use std::{
    collections::BTreeMap,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

const MAX_GROUPS: usize = 128;
#[derive(Default)]
pub(super) struct Groups(Mutex<BTreeMap<u32, Arc<Group>>>);
pub(super) struct Group {
    pub(super) pid: u32,
    owner: String,
    leader: AtomicU8,
    gone: AtomicBool,
    leader_exit: Notify,
    cleanup: tokio::sync::Mutex<()>,
}
impl Groups {
    pub(super) fn reserve(&self) -> Result<()> {
        let mut groups = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        groups.retain(|_, group| group.alive().unwrap_or(true));
        anyhow::ensure!(
            groups.len() < MAX_GROUPS,
            "No more background command process groups can run at once."
        );
        Ok(())
    }
    pub(super) fn retain(&self, pid: u32, owner: &str) -> Arc<Group> {
        let group = Arc::new(Group {
            pid,
            owner: owner.into(),
            leader: AtomicU8::new(0),
            gone: AtomicBool::new(false),
            leader_exit: Notify::new(),
            cleanup: tokio::sync::Mutex::new(()),
        });
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(pid, group.clone());
        group
    }
    pub(super) fn signal_owner(&self, owner: &str, signal: i32) {
        let groups = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|group| group.owner == owner)
            .cloned()
            .collect::<Vec<_>>();
        for group in groups {
            let _ = group.signal(signal);
        }
    }
    pub(super) fn count(&self, owner: &str) -> usize {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|group| group.owner == owner && group.alive().unwrap_or(true))
            .count()
    }
    pub(super) async fn cleanup(&self, owner: Option<&str>) -> Result<()> {
        let groups = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .filter(|group| owner.is_none_or(|owner| group.owner == owner))
            .cloned()
            .collect::<Vec<_>>();
        let results =
            futures_util::future::join_all(groups.iter().map(|group| group.cleanup(false))).await;
        let mut catalog = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for group in groups {
            if group.gone.load(Ordering::Acquire)
                && catalog
                    .get(&group.pid)
                    .is_some_and(|existing| Arc::ptr_eq(existing, &group))
            {
                catalog.remove(&group.pid);
            }
        }
        for result in results {
            result?;
        }
        Ok(())
    }
}
impl Group {
    pub(super) fn leader_reaped(&self) {
        self.leader.store(1, Ordering::Release);
        let _ = self.alive();
        self.leader_exit.notify_waiters();
    }
    pub(super) fn leader_unconfirmed(&self) {
        self.leader.store(2, Ordering::Release);
        self.leader_exit.notify_waiters();
    }
    pub(super) fn signal(&self, signal: i32) -> io::Result<()> {
        if !self.alive()? {
            return Ok(());
        }
        // Never fall back to the bare PID: an exited group leader's number can
        // already belong to an unrelated process.
        if unsafe { libc::kill(-(self.pid as i32), signal) } < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                self.gone.store(true, Ordering::Release);
                return Ok(());
            }
            return Err(error);
        }
        Ok(())
    }
    fn alive(&self) -> io::Result<bool> {
        if self.gone.load(Ordering::Acquire) {
            return Ok(false);
        }
        // The application is a subreaper. Only after Tokio has waited for this
        // exact leader may we reap its adopted descendants by owned group.
        #[cfg(target_os = "linux")]
        if self.leader.load(Ordering::Acquire) == 1 {
            for _ in 0..256 {
                let result = unsafe {
                    libc::waitpid(-(self.pid as i32), std::ptr::null_mut(), libc::WNOHANG)
                };
                if result > 0 {
                    continue;
                }
                if result == 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    break;
                }
                return Err(error);
            }
        }
        if unsafe { libc::kill(-(self.pid as i32), 0) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            self.gone.store(true, Ordering::Release);
            Ok(false)
        } else if error.raw_os_error() == Some(libc::EPERM) {
            Ok(true)
        } else {
            Err(error)
        }
    }
    pub(super) async fn cleanup(&self, force: bool) -> Result<()> {
        let _cleanup = self.cleanup.lock().await;
        loop {
            let exit = self.leader_exit.notified();
            tokio::pin!(exit);
            exit.as_mut().enable();
            match self.leader.load(Ordering::Acquire) {
                1 => break,
                2 => anyhow::bail!("The command leader's exit remains unconfirmed."),
                _ => {}
            }
            exit.await;
        }
        if !self.alive()? {
            return Ok(());
        }
        if !force {
            self.signal(libc::SIGTERM)?;
            match tokio::time::timeout(Duration::from_secs(2), self.wait_empty()).await {
                Ok(result) => {
                    result?;
                    return Ok(());
                }
                Err(_) => {}
            }
        }
        self.signal(libc::SIGKILL)?;
        tokio::time::timeout(Duration::from_secs(3), self.wait_empty())
            .await
            .context("The native command process group still exists after termination.")??;
        Ok(())
    }
    async fn wait_empty(&self) -> io::Result<()> {
        loop {
            if !self.alive()? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
