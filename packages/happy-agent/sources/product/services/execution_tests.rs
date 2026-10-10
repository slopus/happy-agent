use super::*;
use std::{io::Write, os::unix::fs::OpenOptionsExt};

#[test]
fn the_supervisors_ascii_admission_marker_confirms_a_running_workload() {
    let directory = tempfile::tempdir().unwrap();
    let execution = Execution {
        process_id: "admissionfixture".to_owned(),
        started_at: 0,
        directory: directory.path().to_owned(),
        token: String::new(),
        stdin: tokio::sync::Mutex::new(None),
        output: Mutex::new(Capture::default()),
        changed: Notify::new(),
        stop: CancellationToken::new(),
        accepting: AtomicBool::new(true),
        finished: AtomicBool::new(false),
        task: Mutex::new(None),
        connections: Mutex::new(Vec::new()),
        capacity: Arc::new(Semaphore::new(64)),
    };
    let marker = directory.path().join("started");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&marker)
        .unwrap();
    assert!(
        !execution.admitted().unwrap(),
        "An empty marker is not admission."
    );
    file.write_all(b"1").unwrap();
    assert!(
        execution.admitted().unwrap(),
        "The native supervisor writes ASCII 1 when exec is admitted."
    );
    fs::write(&marker, b"E").unwrap();
    assert!(
        !execution.admitted().unwrap(),
        "Exec failure is not admission."
    );
    fs::write(&marker, [1]).unwrap();
    assert!(
        !execution.admitted().unwrap(),
        "A binary byte is not the native marker."
    );
}
