pub fn process_running(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM) {
            return false;
        }
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            && stat
                .rsplit_once(')')
                .is_some_and(|(_, tail)| tail.split_whitespace().next() == Some("Z"))
        {
            // Linux may expose a zombie thread-group leader before the other
            // threads finish exiting and release shared database descriptors.
            // A kill command must wait for those threads as well as the leader.
            if std::fs::read_dir(format!("/proc/{pid}/task"))
                .is_ok_and(|tasks| tasks.filter_map(Result::ok).take(2).count() > 1)
            {
                return true;
            }
            return false;
        }
        true
    }
    #[cfg(windows)]
    {
        // The native Windows process handle implementation remains in its platform gate.
        std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .is_ok_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            })
    }
}
