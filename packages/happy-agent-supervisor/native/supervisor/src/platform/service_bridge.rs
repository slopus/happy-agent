//! A private controller socket inherited into the service network namespace.
use crate::service_policy::ServicePolicy;
use crate::{SupervisorResult, invalid_input};
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

pub(super) struct ServiceBridge {
    listener: UnixListener,
    token: [u8; 64],
    port: u16,
}

impl ServiceBridge {
    pub(super) fn bind(policy: &ServicePolicy) -> SupervisorResult<Self> {
        let parent = policy
            .bridge_socket
            .parent()
            .ok_or_else(|| invalid_input("missing bridge parent"))?;
        let metadata = fs::symlink_metadata(parent)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || parent.canonicalize()? != parent
        {
            return Err(invalid_input(
                "the service bridge directory must be private and owned by the daemon",
            )
            .into());
        }
        // Persist stable process identity before acquiring any service runtime resource.
        // A new daemon can distinguish this execution from a reused numeric PID.
        let stat = fs::read_to_string("/proc/self/stat")?;
        let start_time = stat
            .rsplit_once(')')
            .and_then(|(_, fields)| fields.split_whitespace().nth(19))
            .ok_or_else(|| invalid_input("cannot record service supervisor lifetime"))?;
        let mut identity = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(parent.join("process.json"))?;
        identity.write_all(
            serde_json::json!({ "pid": std::process::id(), "startTime": start_time })
                .to_string()
                .as_bytes(),
        )?;
        identity.sync_all()?;
        let listener = UnixListener::bind(&policy.bridge_socket)?;
        fs::set_permissions(&policy.bridge_socket, fs::Permissions::from_mode(0o600))?;
        let token = policy
            .bridge_token
            .as_bytes()
            .try_into()
            .map_err(|_| invalid_input("invalid bridge token"))?;
        Ok(Self {
            listener,
            token,
            port: policy.port,
        })
    }

    /// Start after the workload has forked. Its exec closes the listener descriptor.
    pub(super) fn serve(self) -> SupervisorResult<()> {
        std::thread::Builder::new()
            .name("service-bridge".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                for incoming in self.listener.incoming() {
                    let Ok(stream) = incoming else {
                        break;
                    };
                    if active.fetch_add(1, Ordering::AcqRel) >= 64 {
                        active.fetch_sub(1, Ordering::AcqRel);
                        drop(stream);
                        continue;
                    }
                    let count = Arc::clone(&active);
                    let token = self.token;
                    let port = self.port;
                    let worker = std::thread::Builder::new()
                        .name("service-connection".into())
                        .spawn(move || {
                            let _ = relay(stream, &token, port);
                            count.fetch_sub(1, Ordering::AcqRel);
                        });
                    if worker.is_err() {
                        active.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            })?;
        Ok(())
    }
}

fn relay(mut controller: UnixStream, token: &[u8; 64], port: u16) -> std::io::Result<()> {
    controller.set_read_timeout(Some(Duration::from_secs(5)))?;
    controller.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut presented = [0; 64];
    controller.read_exact(&mut presented)?;
    let difference = presented
        .iter()
        .zip(token)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        });
    if difference != 0 {
        return Err(std::io::Error::other(
            "service bridge authentication failed",
        ));
    }
    let target = SocketAddr::from(([127, 0, 0, 1], port));
    let mut application = match TcpStream::connect_timeout(&target, Duration::from_secs(2)) {
        Ok(socket) => socket,
        Err(error) => {
            controller.write_all(&[0])?;
            return Err(error);
        }
    };
    controller.write_all(&[1])?;
    controller.set_read_timeout(None)?;
    controller.set_write_timeout(None)?;
    let mut outgoing = application.try_clone()?;
    let mut incoming = controller.try_clone()?;
    // Bounded buffers and blocking backpressure; no message accumulation.
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let _ = std::io::copy(&mut incoming, &mut outgoing);
            let _ = outgoing.shutdown(Shutdown::Both);
            let _ = incoming.shutdown(Shutdown::Both);
        });
        let _ = std::io::copy(&mut application, &mut controller);
        let _ = application.shutdown(Shutdown::Both);
        let _ = controller.shutdown(Shutdown::Both);
    });
    Ok(())
}
