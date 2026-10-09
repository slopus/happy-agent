#![cfg(unix)]

use std::{
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    process::{Command, Output},
};

fn command(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_happy-agent"))
        .args(args)
        .env("HAPPY_HOME_DIR", home)
        .output()
        .expect("run native executable")
}

fn installation() -> tempfile::TempDir {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.context")
        .canonicalize()
        .expect("scratch directory");
    tempfile::Builder::new()
        .prefix("")
        .rand_bytes(2)
        .tempdir_in(scratch)
        .expect("temporary installation")
}

struct Foreground(std::process::Child);
impl Drop for Foreground {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct DaemonGuard<'a>(&'a Path);
impl Drop for DaemonGuard<'_> {
    fn drop(&mut self) {
        let _ = command(self.0, &["kill"]);
    }
}

#[test]
fn startup_health_is_served_while_database_restoration_waits() {
    let temporary = installation();
    let home = temporary.path().join(".happy");
    let _guard = DaemonGuard(&home);
    assert!(command(&home, &["start"]).status.success());
    assert!(command(&home, &["stop"]).status.success());
    let database =
        rusqlite::Connection::open(home.join("agent/agent.sqlite")).expect("existing installation");
    database
        .execute_batch("BEGIN IMMEDIATE")
        .expect("hold restoration's loader transaction");
    let mut foreground = Foreground(
        Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("run")
            .env("HAPPY_HOME_DIR", &home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("foreground daemon"),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !home.join("agent/server.sock").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "daemon binds its starting listener"
        );
        assert!(
            foreground.0.try_wait().expect("process status").is_none(),
            "daemon is waiting for restoration"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let token = std::fs::read_to_string(home.join("agent/token")).expect("starting credential");
    let mut socket = UnixStream::connect(home.join("agent/server.sock")).expect("starting socket");
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(1)))
        .expect("bounded health read");
    write!(socket,"GET /v0/health HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",token.trim()).expect("health request");
    let mut response = String::new();
    socket
        .read_to_string(&mut response)
        .expect("health is served during database restoration");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let (_, body) = response.split_once("\r\n\r\n").expect("health response");
    let health: serde_json::Value = serde_json::from_str(body).expect("health JSON");
    assert_eq!(health["ready"], false);
    assert_eq!(health["status"], "starting");
    assert_eq!(request(&home, Some(token.trim()), "GET", "/").0, 503);
    database
        .execute_batch("ROLLBACK")
        .expect("release restoration");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while request(&home, Some(token.trim()), "GET", "/v0/health").1["ready"] != true {
        assert!(
            std::time::Instant::now() < deadline,
            "restoration publishes ready"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(command(&home, &["stop"]).status.success());
}

fn request(home: &Path, token: Option<&str>, method: &str, path: &str) -> (u16, serde_json::Value) {
    let mut socket = UnixStream::connect(home.join("agent/server.sock")).expect("connect socket");
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .expect("read deadline");
    let authorization = token.map_or_else(String::new, |token| {
        format!("Authorization: Bearer {token}\r\n")
    });
    write!(socket, "{method} {path} HTTP/1.1\r\nHost: arbitrary.example\r\n{authorization}Content-Length: 0\r\nConnection: close\r\n\r\n")
        .expect("send HTTP request");
    let mut response = String::new();
    socket.read_to_string(&mut response).expect("read response");
    let (headers, body) = response.split_once("\r\n\r\n").expect("HTTP response");
    assert!(headers.to_lowercase().contains("cache-control: no-store"));
    let status = headers
        .split_whitespace()
        .nth(1)
        .expect("status")
        .parse()
        .expect("numeric status");
    (status, serde_json::from_str(body).expect("JSON body"))
}

#[test]
fn original_commands_use_authenticated_daemon_and_preserve_installation() {
    // Unix socket paths retain the original 103-byte bound, including a long checkout root.
    let temporary = installation();
    let home = temporary.path().join(".happy");
    let _guard = DaemonGuard(&home);
    let started = command(&home, &["start"]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    assert!(String::from_utf8_lossy(&started.stdout).contains("Daemon is running at"));
    let token = std::fs::read_to_string(home.join("agent/token")).expect("token");
    assert_eq!(token.trim().len(), 43);
    assert_eq!(
        std::fs::metadata(home.join("agent/token"))
            .expect("token metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(home.join("agent/server.sock"))
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let (status, health) = request(&home, Some(token.trim()), "GET", "/v0/health");
    assert_eq!(status, 200);
    assert_eq!(health["version"]["protocol"], 26);
    assert_eq!(health["ready"], true);
    assert_eq!(request(&home, None, "GET", "/v0/health").0, 401);
    let (_, authentication) = request(&home, None, "GET", "/v0/authentication?ignored=1");
    assert_eq!(
        authentication,
        serde_json::json!({"authenticated":false,"userId":null,"methods":[]})
    );
    assert_eq!(
        request(&home, Some(token.trim()), "GET", "/").1,
        serde_json::json!({"text":"Welcome to Happy Agent!"})
    );
    assert_eq!(
        request(&home, Some(token.trim()), "POST", "/v0/debug/inspector").0,
        409
    );
    let db = rusqlite::Connection::open(home.join("agent/agent.sqlite"))
        .expect("original database path");
    let epoch: String = db
        .query_row(
            "SELECT value FROM happy_agent_loader_state WHERE key='installation_epoch'",
            [],
            |row| row.get(0),
        )
        .expect("installation epoch");
    db.execute("INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES('unrelated','opaque','not-json')", []).expect("unrelated persisted state");
    drop(db);
    // Local drain does not need API credentials and stays alive after completion.
    std::fs::rename(home.join("agent/token"), home.join("agent/token.saved"))
        .expect("remove token from launcher");
    let drained = command(&home, &["drain"]);
    assert!(
        drained.status.success(),
        "{}",
        String::from_utf8_lossy(&drained.stderr)
    );
    assert_eq!(
        request(&home, Some(token.trim()), "GET", "/v0/health").1["draining"],
        true
    );
    assert_eq!(
        request(&home, Some(token.trim()), "PUT", "/v0/config/instructions").0,
        503
    );
    std::fs::rename(home.join("agent/token.saved"), home.join("agent/token"))
        .expect("restore launcher token");
    assert!(command(&home, &["reload"]).status.success());
    assert_eq!(
        std::fs::read_to_string(home.join("agent/token")).expect("reloaded token"),
        token
    );
    let db =
        rusqlite::Connection::open(home.join("agent/agent.sqlite")).expect("reloaded database");
    assert_eq!(
        db.query_row(
            "SELECT value FROM happy_agent_loader_state WHERE key='installation_epoch'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("same epoch"),
        epoch
    );
    assert_eq!(
        db.query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id='unrelated'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("unrelated state preserved"),
        "not-json"
    );
    drop(db);
    assert!(command(&home, &["stop"]).status.success());
    assert!(!home.join("agent/server.sock").exists());
    assert!(!home.join("agent/daemon.pid").exists());
    assert!(
        String::from_utf8_lossy(&command(&home, &["status"]).stdout)
            .contains("Daemon is not running.")
    );
}

#[test]
fn populated_original_installation_and_canonical_owner_lock_are_preserved() {
    let temporary = installation();
    let home = temporary.path().join(".happy");
    let directory = home.join("agent");
    std::fs::create_dir_all(&directory).expect("installation directory");
    let db = rusqlite::Connection::open(directory.join("agent.sqlite")).expect("old installation");
    db.execute_batch("CREATE TABLE happy_agent_migrations(module_key TEXT NOT NULL,migration_key TEXT NOT NULL,position BIGINT NOT NULL,PRIMARY KEY(module_key,migration_key),UNIQUE(module_key,position));
        CREATE TABLE happy_agent_records(owner_id TEXT NOT NULL,position BIGINT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(owner_id,position));
        CREATE TABLE happy_agent_values(owner_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(owner_id,key));
        CREATE TABLE happy_agent_loader_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO happy_agent_migrations VALUES('@happy-agent-base','001-core-storage',0),('happy-agent-installation','001-root-agent',0),('happy-agent-installation','002-drop-root-agent',1),('unported-module','historical-key',0);
        INSERT INTO happy_agent_loader_state VALUES('installation_epoch','prior-installation-epoch'),('schema_version','1');
        INSERT INTO happy_agent_records VALUES('prior-agent',0,'opaque original record');
        INSERT INTO happy_agent_values VALUES('prior-agent','pending.message','opaque original pending input');
        CREATE TABLE retained_module_rows(id TEXT PRIMARY KEY,payload BLOB);
        INSERT INTO retained_module_rows VALUES('prior-resource',x'000102ff');").expect("original schema fixture");
    drop(db);
    let owner = rusqlite::Connection::open(directory.join("agent.sqlite.lock"))
        .expect("original canonical lock");
    owner
        .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; BEGIN IMMEDIATE;")
        .expect("other runtime holds ownership");
    let refused = command(&home, &["run"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("already open in another process"));
    assert!(!directory.join("daemon.pid").exists());
    owner.execute_batch("ROLLBACK").expect("owner exits");
    drop(owner);
    let _guard = DaemonGuard(&home);
    let started = command(&home, &["start"]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let pid = std::fs::read_to_string(directory.join("daemon.pid")).expect("owner PID");
    assert!(command(&home, &["start"]).status.success());
    assert_eq!(
        std::fs::read_to_string(directory.join("daemon.pid")).expect("same owner PID"),
        pid
    );
    // A direct second foreground process must not overwrite a live owner's PID or token.
    let token = std::fs::read_to_string(directory.join("token")).expect("owner token");
    assert!(!command(&home, &["run"]).status.success());
    assert_eq!(
        std::fs::read_to_string(directory.join("daemon.pid")).expect("unchanged owner PID"),
        pid
    );
    assert_eq!(
        std::fs::read_to_string(directory.join("token")).expect("unchanged token"),
        token
    );
    let contender =
        rusqlite::Connection::open(directory.join("agent.sqlite.lock")).expect("contender");
    contender
        .busy_timeout(std::time::Duration::ZERO)
        .expect("no wait");
    assert!(contender.execute_batch("BEGIN IMMEDIATE").is_err());
    assert!(command(&home, &["kill"]).status.success());
    contender
        .execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
        .expect("crash releases original lock");
    drop(contender);
    assert!(command(&home, &["start"]).status.success());
    assert!(command(&home, &["stop"]).status.success());
    let db = rusqlite::Connection::open(directory.join("agent.sqlite")).expect("retained database");
    assert_eq!(
        db.query_row(
            "SELECT value FROM happy_agent_loader_state WHERE key='installation_epoch'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("prior epoch"),
        "prior-installation-epoch"
    );
    assert_eq!(
        db.query_row(
            "SELECT record_json FROM happy_agent_records WHERE owner_id='prior-agent'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("prior private context"),
        "opaque original record"
    );
    assert_eq!(
        db.query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id='prior-agent'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("prior queue"),
        "opaque original pending input"
    );
    assert_eq!(
        db.query_row(
            "SELECT payload FROM retained_module_rows WHERE id='prior-resource'",
            [],
            |row| row.get::<_, Vec<u8>>(0)
        )
        .expect("module state"),
        vec![0, 1, 2, 255]
    );
    assert_eq!(
        db.query_row(
            "SELECT migration_key FROM happy_agent_migrations WHERE module_key='unported-module'",
            [],
            |row| row.get::<_, String>(0)
        )
        .expect("module migration"),
        "historical-key"
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("original generation"),
        0
    );
}

#[test]
fn original_help_version_and_argument_validation_remain_public() {
    let temporary = tempfile::tempdir().expect("temporary home");
    for args in [vec![], vec!["--help"], vec!["-h"]] {
        let output = command(temporary.path(), &args);
        assert!(output.status.success());
        let help = String::from_utf8_lossy(&output.stdout);
        for name in [
            "start", "run", "status", "drain", "stop", "kill", "reload", "runner", "sandbox",
        ] {
            assert!(help.contains(name), "help omits {name}");
        }
    }
    assert!(command(temporary.path(), &["-v"]).status.success());
    for command_name in ["start", "run", "status", "drain", "stop", "kill", "reload"] {
        assert!(
            !command(temporary.path(), &[command_name, "--help"])
                .status
                .success()
        );
    }
}

#[test]
fn fixed_machine_token_is_used_from_readiness_and_signal_drain_refuses_symlinks() {
    let temporary = installation();
    let home = temporary.path().join(".happy");
    let public = temporary.path().join(if cfg!(target_os = "macos") {
        "Happy/Config"
    } else {
        "happy/config"
    });
    std::fs::create_dir_all(&public).expect("global configuration directory");
    let token = "c".repeat(43);
    std::fs::write(
        public.join("happy.toml"),
        format!("[api]\ntoken = \"{token}\"\n"),
    )
    .expect("fixed machine token");
    let _guard = DaemonGuard(&home);
    let started = command(&home, &["start"]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(home.join("agent/token"))
            .expect("persisted fixed token")
            .trim(),
        token
    );
    assert_eq!(request(&home, Some(&token), "GET", "/v0/health").0, 200);
    let state = home.join("agent/drain.json");
    let saved = home.join("agent/drain.saved.json");
    std::fs::rename(&state, &saved).expect("save drain state");
    std::os::unix::fs::symlink(&saved, &state).expect("untrusted drain symlink");
    let refused = command(&home, &["drain"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("No signal was sent"));
    assert_eq!(
        request(&home, Some(&token), "GET", "/v0/health").1["draining"],
        false
    );
    std::fs::remove_file(&state).expect("remove symlink");
    std::fs::rename(&saved, &state).expect("restore original state");
    assert!(command(&home, &["stop"]).status.success());
}

#[test]
fn foreground_start_refuses_to_replace_an_ordinary_socket_path() {
    let temporary = installation();
    let home = temporary.path().join(".happy");
    std::fs::create_dir_all(home.join("agent")).expect("installation directory");
    let socket = home.join("agent/server.sock");
    std::fs::write(&socket, "ordinary user file").expect("ordinary socket path");
    let refused = command(&home, &["run"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("Refusing to replace"));
    assert_eq!(
        std::fs::read_to_string(&socket).expect("original ordinary file"),
        "ordinary user file"
    );
    assert!(!home.join("agent/daemon.pid").exists());
}
