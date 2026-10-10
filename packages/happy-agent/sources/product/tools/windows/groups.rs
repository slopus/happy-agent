//! Exact Job ownership survives an ordinary shell leader exit.
use super::signals;
use anyhow::{Context as _, Result};
use happy_agent_supervisor::windows::{Control, Job};
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

// A global retention bound also covers surviving trees after their shell rows
// have retired. It does not lower Source's per-compute 256-program capacity.
const MAX_GROUPS: usize = 4096;

#[derive(Default)]
pub(super) struct Groups(Mutex<BTreeMap<usize, Arc<Group>>>);
pub(super) struct Group {
    pub(super) pid: u32,
    owner: String,
    job: Arc<Job>,
    terminal: Option<Control>,
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
            "No more native Windows command trees can run at once."
        );
        Ok(())
    }
    pub(super) fn retain(
        &self,
        pid: u32,
        owner: &str,
        job: Arc<Job>,
        terminal: Option<Control>,
    ) -> Arc<Group> {
        let group = Arc::new(Group {
            pid,
            owner: owner.into(),
            job,
            terminal,
            leader: AtomicU8::new(0),
            gone: AtomicBool::new(false),
            leader_exit: Notify::new(),
            cleanup: tokio::sync::Mutex::new(()),
        });
        // Windows may reuse an exited leader PID while descendants still own
        // their Job. An allocated, retained group identity cannot collide.
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(Arc::as_ptr(&group) as usize, group.clone());
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
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, group| !group.gone.load(Ordering::Acquire));
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
        // Windows provides no POSIX graceful termination for pipe-backed
        // processes. Source's supported termination signals stop the Job.
        match signal {
            signals::SIGINT | signals::SIGQUIT | signals::SIGTERM | signals::SIGKILL => {
                self.job.terminate()
            }
            _ => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "This process signal is not available on Windows.",
            )),
        }
    }
    fn alive(&self) -> io::Result<bool> {
        if self.gone.load(Ordering::Acquire) {
            return Ok(false);
        }
        if self.job.active_processes()? == 0 {
            self.gone.store(true, Ordering::Release);
            return Ok(false);
        }
        Ok(true)
    }
    pub(super) async fn cleanup(&self, _force: bool) -> Result<()> {
        let _cleanup = self.cleanup.lock().await;
        loop {
            let exit = self.leader_exit.notified();
            tokio::pin!(exit);
            exit.as_mut().enable();
            match self.leader.load(Ordering::Acquire) {
                1 => break,
                2 => anyhow::bail!("The Windows command leader's exit remains unconfirmed."),
                _ => {}
            }
            exit.await;
        }
        if self.alive()? {
            self.job.terminate()?;
            tokio::time::timeout(Duration::from_secs(3), async {
                while self.alive()? {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Ok::<_, io::Error>(())
            })
            .await
            .context("The Windows command tree still exists after termination.")??;
        }
        if let Some(terminal) = &self.terminal {
            terminal.close().await?;
        }
        Ok(())
    }
}
