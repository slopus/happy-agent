use super::*;
use crate::product::{durable::DurableFunctionsModule, events::EventsModule};

struct Fixture {
    directory: tempfile::TempDir,
    commands: CommandSessions,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifecycle: Arc<LifecycleModule>,
    secrets: Arc<SecretsModule>,
    configuration: Value,
}
impl Fixture {
    async fn new() -> Self {
        crate::product::process::prepare_child_reaping().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let durable =
            Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
        durable.load().await.unwrap();
        let events = Arc::new(EventsModule::new(runtime.clone()).unwrap());
        events.load().await.unwrap();
        let secrets = SecretsModule::new(
            config.clone(),
            runtime.clone(),
            durable.clone(),
            events.clone(),
        )
        .unwrap();
        secrets.load().await.unwrap();
        let configuration = json!({"modules":{"compute":{"cwd":directory.path()}}});
        let commands = CommandSessions::new(
            config.clone(),
            lifecycle.clone(),
            runtime.clone(),
            secrets.clone(),
            events,
            crate::product::owners::RunnersModule::new(config, runtime.clone(), lifecycle.clone())
                .unwrap(),
        )
        .unwrap();
        Self {
            directory,
            commands,
            runtime,
            durable,
            lifecycle,
            configuration,
            secrets,
        }
    }
    async fn start(&self, command: &str, tty: bool, wait: u64) -> Value {
        self.commands
            .start(
                "terminalfixture",
                &self.configuration,
                "full_access",
                &json!({"cmd":command,"tty":tty,"yield_time_ms":wait}),
                CancellationToken::new(),
            )
            .await
            .unwrap()
    }
    async fn close(&self) {
        self.commands.close().await;
        self.lifecycle.begin_shutdown();
        self.durable.stop().await;
        self.runtime.close().await.unwrap();
    }
}

#[tokio::test]
async fn full_access_commands_run_without_requiring_a_sandbox_namespace() {
    let fixture = Fixture::new().await;
    let result = fixture
        .start("printf 'native full access'", false, 1000)
        .await;
    fixture.close().await;
    assert_eq!(result["exit_code"], 0, "{result}");
    assert_eq!(result["output"], "native full access");
}

#[tokio::test]
async fn output_polling_keeps_incomplete_utf8_until_the_character_is_complete() {
    let fixture = Fixture::new().await;
    let started=fixture.start("exec python3 -u -c 'import sys; sys.stdout.buffer.write(bytes([226,130])); sys.stdout.buffer.flush(); sys.stdin.readline(); sys.stdout.buffer.write(bytes([172,10])); sys.stdout.buffer.flush()'",false,250).await;
    let session = started["session_id"]
        .as_u64()
        .expect("the command is awaiting its input");
    let completed = fixture
        .commands
        .input(
            "terminalfixture",
            session,
            &json!({"chars":"finish\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(started["output"], "", "{started}");
    assert_eq!(completed["output"], "€\n", "{completed}");
}

#[tokio::test]
async fn bounded_capture_preserves_both_the_start_and_end_of_a_large_stream() {
    let fixture = Fixture::new().await;
    let result=fixture.start("exec python3 -u -c 'import sys; sys.stdout.write(\"capture-start-marker\\n\"+\"x\"*1400000+\"\\ncapture-end-marker\\n\")'",false,1000).await;
    fixture.close().await;
    let output = result["output"].as_str().unwrap();
    assert!(
        output.contains("capture-start-marker"),
        "the stream lost its beginning"
    );
    assert!(
        output.contains("capture-end-marker"),
        "the stream lost its ending"
    );
    assert!(
        output.contains("bytes of this session's output"),
        "capture omissions are disclosed"
    );
    assert!(result["original_token_count"].as_u64().unwrap() > 350_000);
}

#[tokio::test]
async fn tty_commands_receive_a_controlling_terminal_and_source_terminal_defaults() {
    let fixture = Fixture::new().await;
    let result = fixture.start("test -t 0 && test -t 1 && test -t 2 && test -r /dev/tty && printf 'tty size:' && stty size && printf 'terminal:%s|%s|%s|%s|%s|%s|%s\\n' \"$TERM\" \"$COLORTERM\" \"$NO_COLOR\" \"$PAGER\" \"$GIT_PAGER\" \"$GH_PAGER\" \"$(ps -o tty= -p $$)\" && printf 'stderr merged\\n' >&2", true, 1000).await;
    fixture.close().await;
    assert_eq!(result["exit_code"], 0, "{result}");
    let output = result["output"].as_str().unwrap();
    assert!(output.contains("tty size:24 80"), "{output:?}");
    assert!(
        output.contains("terminal:dumb||1|cat|cat|cat|"),
        "{output:?}"
    );
    assert!(!output.contains("|?"), "{output:?}");
    assert!(output.contains("stderr merged"), "{output:?}");
}

#[tokio::test]
async fn tty_input_is_delivered_and_terminal_control_c_interrupts_the_foreground_group() {
    let fixture = Fixture::new().await;
    let started = fixture.start("stty -echo; printf 'ready for input\\n'; IFS= read -r line; printf 'received:%s\\n' \"$line\"", true, 250).await;
    let session = started["session_id"]
        .as_u64()
        .expect("a real terminal is awaiting input");
    assert!(
        started["output"]
            .as_str()
            .unwrap()
            .contains("ready for input"),
        "{started}"
    );
    let received = fixture
        .commands
        .input(
            "terminalfixture",
            session,
            &json!({"chars":"hello terminal\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(received["exit_code"], 0, "{received}");
    assert_eq!(received["output"], "received:hello terminal\r\n");

    let started = fixture.start("exec python3 -u -c 'import signal,time; signal.signal(signal.SIGINT,lambda *_: (print(\"terminal interrupt\",flush=True),exit(7))); print(\"interrupt ready\",flush=True); time.sleep(60)'", true, 250).await;
    let session = started["session_id"].as_u64().unwrap();
    assert!(
        started["output"]
            .as_str()
            .unwrap()
            .contains("interrupt ready"),
        "{started}"
    );
    let interrupted = fixture
        .commands
        .input(
            "terminalfixture",
            session,
            &json!({"chars":"\u{0003}","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(interrupted["exit_code"], 7, "{interrupted}");
    assert!(
        interrupted["output"]
            .as_str()
            .unwrap()
            .contains("terminal interrupt"),
        "{interrupted}"
    );
}

#[tokio::test]
async fn background_terminal_outlives_its_caller_and_remains_owned_by_its_agent() {
    let fixture = Fixture::new().await;
    let caller = CancellationToken::new();
    let started = fixture.commands.start("terminalfixture", &fixture.configuration, "full_access", &json!({"cmd":"stty -echo; printf 'ready\\n'; read -r line; printf 'response:%s\\n' \"$line\"","tty":true,"yield_time_ms":250}), caller.clone()).await.unwrap();
    let session = started["session_id"].as_u64().unwrap();
    caller.cancel();
    assert!(
        fixture
            .commands
            .input(
                "anotheragent",
                session,
                &json!({"chars":"wrong\n"}),
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    let cancelled_poll = CancellationToken::new();
    cancelled_poll.cancel();
    assert!(
        fixture
            .commands
            .input(
                "terminalfixture",
                session,
                &json!({"yield_time_ms":0}),
                cancelled_poll
            )
            .await
            .is_err()
    );
    let received = fixture
        .commands
        .input(
            "terminalfixture",
            session,
            &json!({"chars":"still here\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(received["exit_code"], 0, "{received}");
    assert_eq!(received["output"], "response:still here\r\n");
}

#[tokio::test]
async fn completed_shell_descendants_remain_owned_until_shutdown() {
    let fixture = Fixture::new().await;
    let completed = fixture
        .start("sleep 60 >/dev/null 2>&1 & printf '%s' \"$!\"", false, 1000)
        .await;
    let child: u32 = completed["output"].as_str().unwrap().parse().unwrap();
    let alive_after_shell_exit = crate::product::process::process_running(child);
    fixture.close().await;
    assert_eq!(completed["exit_code"], 0, "{completed}");
    assert!(
        alive_after_shell_exit,
        "A normal shell exit killed the descendant that Source keeps owned for shutdown."
    );
    assert!(
        !crate::product::process::process_running(child),
        "Shutdown left an owned descendant running."
    );
}

#[tokio::test]
async fn detached_processes_keep_one_public_identity_and_emit_only_lifecycle_data() {
    let fixture = Fixture::new().await;
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = observed.clone();
    let _subscription = fixture
        .commands
        .on_process_event(Arc::new(move |event| {
            let mut events = captured.lock().unwrap();
            assert!(events.len() < 8);
            events.push(event);
        }))
        .unwrap();
    let foreground = fixture.start("printf 'foreground'", false, 1000).await;
    assert_eq!(foreground["exit_code"], 0);
    assert!(
        fixture
            .commands
            .list_processes("terminalfixture")
            .is_empty()
    );
    let started = fixture
        .start(
            "stty -echo; read -r value; printf '%s' \"$value\"",
            true,
            250,
        )
        .await;
    let session = started["session_id"].as_u64().unwrap();
    let before = fixture.commands.list_processes("terminalfixture");
    assert_eq!(before.len(), 1);
    assert_eq!(before[0]["status"], "running");
    assert_eq!(fixture.commands.running_processes("terminalfixture"), 1);
    let id = before[0]["id"].as_str().unwrap().to_owned();
    assert!(
        fixture
            .commands
            .stop_process("anotheragent", &id)
            .await
            .unwrap()
            .is_none()
    );
    let finished = fixture
        .commands
        .input(
            "terminalfixture",
            session,
            &json!({"chars":"private terminal response\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(finished["exit_code"], 0);
    let after = fixture
        .commands
        .stop_process("terminalfixture", &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after["id"], before[0]["id"]);
    assert_eq!(after["status"], "exited");
    assert_eq!(after["exitCode"], 0);
    assert!(after["version"].as_str().unwrap() > before[0]["version"].as_str().unwrap());
    assert_eq!(fixture.commands.running_processes("terminalfixture"), 0);
    assert_eq!(
        fixture
            .commands
            .stop_process("terminalfixture", &id)
            .await
            .unwrap()
            .unwrap(),
        after
    );
    let durable = fixture
        .runtime
        .transact(|ctx| {
            Ok(ctx.database().query_row(
                "SELECT count(*) FROM happy_agent_events WHERE type LIKE 'process.%'",
                [],
                |row| row.get::<_, usize>(0),
            )?)
        })
        .await
        .unwrap();
    fixture.close().await;
    let events = observed.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["process_started", "process_exited"]
    );
    assert_eq!(
        durable, 0,
        "Daemon-lifetime process state must not become durable SQL events."
    );
    for event in events.iter() {
        let payload = event.to_string();
        assert!(!payload.contains("private terminal response"));
        assert!(!payload.contains("session_id"));
    }
    assert_eq!(events[1]["previousVersion"], before[0]["version"]);
}

#[tokio::test]
async fn archival_reaps_an_uncooperative_process_group_and_preserves_other_owners() {
    let fixture = Fixture::new().await;
    let own = fixture
        .start(
            "trap '' TERM; sleep 60 & printf '%s' \"$!\"; wait",
            false,
            250,
        )
        .await;
    let session = own["session_id"].as_u64().unwrap();
    let child = own["output"].as_str().unwrap().parse::<u32>().unwrap();
    let group = fixture
        .commands
        .session("terminalfixture", session)
        .unwrap()
        .group
        .pid;
    let other = fixture
        .commands
        .start(
            "anotheragent",
            &fixture.configuration,
            "full_access",
            &json!({"cmd":"read -r value; printf 'other:%s' \"$value\"","yield_time_ms":250}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture
        .commands
        .archive_agent("terminalfixture", &CancellationToken::new())
        .await
        .unwrap();
    fixture
        .commands
        .archive_agent("terminalfixture", &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(unsafe { libc::kill(-(group as i32), 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert!(!crate::product::process::process_running(child));
    let other = fixture
        .commands
        .input(
            "anotheragent",
            other["session_id"].as_u64().unwrap(),
            &json!({"chars":"survived\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(other["exit_code"], 0, "{other}");
    assert_eq!(other["output"], "other:survived");
}

#[tokio::test]
async fn actual_command_environments_hide_attached_values_until_exact_selection() {
    let fixture = Fixture::new().await;
    let ambient = std::env::vars()
        .find(|(name, _)| name == "TMPDIR" || name == "CARGO_MANIFEST_DIR")
        .expect("Cargo supplies a harmless fixture environment variable")
        .0;
    let mixed = ambient.to_ascii_lowercase();
    let secrets = fixture.secrets.clone();
    let environment_name = mixed.clone();
    fixture.runtime.transact(move |ctx| {
        secrets.create(ctx, &json!({"id":"command-environment","description":"Command environment fixture","environment":{(environment_name):"fixture-selected-command-value"}}), None)?;
        secrets.attach(ctx, "command-environment", &json!({"type":"agent","id":"terminalfixture"}), None)?;
        Ok(())
    }).await.unwrap();
    let omitted = fixture
        .start(
            &format!(
                "test -z \"${{{ambient}+x}}\" && test -z \"${{{mixed}+x}}\" && printf 'hidden'"
            ),
            false,
            1000,
        )
        .await;
    std::fs::write(
        fixture.directory.path().join("expected-fixture-value"),
        "fixture-selected-command-value",
    )
    .unwrap();
    let selected = fixture.commands.start("terminalfixture", &fixture.configuration, "full_access", &json!({"cmd":format!("test -z \"${{{ambient}+x}}\" && read -r expected < expected-fixture-value; test \"${mixed}\" = \"$expected\" && printf 'selected matches'"),"secrets":["command-environment"],"yield_time_ms":1000}), CancellationToken::new()).await.unwrap();
    let refused = fixture.commands.start("anotheragent", &fixture.configuration, "full_access", &json!({"cmd":"printf 'should not start' > forbidden-effect","secrets":["command-environment"]}), CancellationToken::new()).await;
    let escaped = fixture
        .commands
        .start(
            "terminalfixture",
            &fixture.configuration,
            "workspace_write",
            &json!({"cmd":"printf 'should not start'","workdir":"/"}),
            CancellationToken::new(),
        )
        .await;
    let no_effect = !fixture.directory.path().join("forbidden-effect").exists();
    let public = fixture
        .runtime
        .transact(|ctx| {
            let mut statement = ctx.database().prepare(
                "SELECT payload_json FROM happy_agent_events WHERE type LIKE 'secret.%'",
            )?;
            Ok(statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(omitted["exit_code"], 0, "{omitted}");
    assert_eq!(omitted["output"], "hidden");
    assert_eq!(selected["exit_code"], 0, "{selected}");
    assert_eq!(selected["output"], "selected matches");
    assert!(refused.is_err() && escaped.is_err() && no_effect);
    assert!(
        public
            .iter()
            .all(|event| !event.contains("fixture-selected-command-value"))
    );
}

#[tokio::test]
async fn abort_notifies_exit_before_killing_and_reaps_completed_shell_descendants() {
    use std::sync::atomic::{AtomicBool, AtomicU32};
    let fixture = Fixture::new().await;
    let background = fixture
        .start("sleep 60 >/dev/null 2>&1 & printf '%s' \"$!\"", false, 1000)
        .await;
    let descendant: u32 = background["output"].as_str().unwrap().parse().unwrap();
    let started = fixture
        .start(
            "trap '' TERM; printf 'running'; while :; do sleep 60; done",
            true,
            250,
        )
        .await;
    let session = started["session_id"].as_u64().unwrap();
    let group = fixture
        .commands
        .session("terminalfixture", session)
        .unwrap()
        .group
        .pid;
    let watched = Arc::new(AtomicU32::new(group));
    let alive = Arc::new(AtomicBool::new(false));
    let observed = alive.clone();
    let _subscription = fixture
        .commands
        .on_process_event(Arc::new(move |event| {
            if event["type"] == "process_exited" {
                let still_running =
                    unsafe { libc::kill(-(watched.load(Ordering::Acquire) as i32), 0) } == 0;
                observed.store(still_running, Ordering::Release);
            }
        }))
        .unwrap();
    assert_eq!(fixture.commands.abort_process_trees("terminalfixture"), 2);
    fixture
        .commands
        .hard_kill_agent("terminalfixture")
        .await
        .unwrap();
    let records = fixture.commands.list_processes("terminalfixture");
    fixture.close().await;
    assert!(
        alive.load(Ordering::Acquire),
        "The exit observer ran after the kill signal."
    );
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["status"], "exited");
    assert!(records[0]["exitCode"].is_null());
    assert!(!crate::product::process::process_running(descendant));
    assert_eq!(unsafe { libc::kill(-(group as i32), 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[tokio::test]
async fn failing_process_observers_do_not_fail_the_command_or_its_cleanup() {
    let fixture = Fixture::new().await;
    let observer = fixture
        .commands
        .on_process_event(Arc::new(|_| panic!("Synthetic optional observer failure")))
        .unwrap();
    let started = fixture
        .start(
            "stty -echo; read -r line; printf 'command survived'",
            true,
            250,
        )
        .await;
    drop(observer);
    let completed = fixture
        .commands
        .input(
            "terminalfixture",
            started["session_id"].as_u64().unwrap(),
            &json!({"chars":"continue\n","yield_time_ms":1000}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    fixture.close().await;
    assert_eq!(completed["exit_code"], 0);
    assert_eq!(completed["output"], "command survived");
}
