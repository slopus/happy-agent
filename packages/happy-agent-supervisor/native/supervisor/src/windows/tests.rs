use super::{Child, Command};
use std::{
    io::{Read, Write},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn fixture(operation: &str) -> Command {
    let mut command = Command::new(
        std::env::current_exe().unwrap_or_else(|error| panic!("test executable: {error}")),
    );
    command
        .args(["--exact", "windows::tests::child_fixture", "--nocapture"])
        .env("HAPPY_WINDOWS_TEST_OPERATION", operation);
    command
}

async fn line_containing(reader: &mut BufReader<super::Stream>, marker: &str) -> String {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(
                reader
                    .read_line(&mut line)
                    .await
                    .unwrap_or_else(|error| panic!("read fixture line: {error}")),
                0,
                "EOF before {marker}"
            );
            if line.contains(marker) {
                return line;
            }
        }
    })
    .await
    .unwrap_or_else(|error| panic!("fixture became ready: {error}"))
}

async fn finish(child: &mut Child) -> std::process::ExitStatus {
    tokio::time::timeout(Duration::from_secs(20), child.wait())
        .await
        .unwrap_or_else(|error| panic!("child exited: {error}"))
        .unwrap_or_else(|error| panic!("wait child: {error}"))
}

#[tokio::test]
async fn pipes_roundtrip_unicode_and_finish_while_parent_stdin_is_open() {
    let mut child = fixture("echo")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn echo: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "ECHO_READY").await;
    child
        .stdin
        .as_mut()
        .unwrap_or_else(|| panic!("stdin"))
        .write_all("native ping 🎉\n".as_bytes())
        .await
        .unwrap_or_else(|error| panic!("write input: {error}"));
    let errors = child.stderr.take().unwrap_or_else(|| panic!("stderr"));
    let read_errors = tokio::spawn(async move {
        let mut errors = errors;
        let mut result = Vec::new();
        errors
            .read_to_end(&mut result)
            .await
            .unwrap_or_else(|error| panic!("read stderr: {error}"));
        result
    });
    let line = line_containing(&mut output, "ECHO_RESULT:").await;
    assert!(line.contains("ECHO_RESULT:native ping 🎉"));
    assert_eq!(finish(&mut child).await.code(), Some(37));
    assert_eq!(
        read_errors
            .await
            .unwrap_or_else(|error| panic!("stderr task: {error}")),
        b"ECHO_ERROR\n"
    );
    assert!(
        child.stdin.is_some(),
        "waiting for exit must not require parent EOF"
    );
}

#[tokio::test]
async fn output_drains_all_tiny_writes_without_dropping_or_reordering_bytes() {
    let mut child = fixture("burst")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn burst: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "BURST_READY").await;
    let mut errors = child.stderr.take().unwrap_or_else(|| panic!("stderr"));
    let read_output = tokio::spawn(async move {
        let mut bytes = Vec::new();
        output
            .read_to_end(&mut bytes)
            .await
            .unwrap_or_else(|error| panic!("read output: {error}"));
        bytes
    });
    let read_errors = tokio::spawn(async move {
        let mut bytes = Vec::new();
        errors
            .read_to_end(&mut bytes)
            .await
            .unwrap_or_else(|error| panic!("read errors: {error}"));
        bytes
    });
    assert_eq!(finish(&mut child).await.code(), Some(0));
    let expected_output: Vec<_> = (0..32_768u32).flat_map(u32::to_le_bytes).collect();
    let expected_errors: Vec<_> = (0..32_768u32)
        .flat_map(|index| (u32::MAX - index).to_le_bytes())
        .collect();
    assert_eq!(
        read_output
            .await
            .unwrap_or_else(|error| panic!("output task: {error}")),
        expected_output
    );
    assert_eq!(
        read_errors
            .await
            .unwrap_or_else(|error| panic!("error task: {error}")),
        expected_errors
    );
}

#[tokio::test]
async fn conpty_roundtrips_input_merges_output_and_reports_resized_dimensions() {
    let mut command = fixture("terminal");
    let (output, mut input, control) = command
        .attach_terminal(84, 21)
        .unwrap_or_else(|error| panic!("create ConPTY: {error}"));
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| panic!("spawn terminal: {error}"));
    assert!(child.stderr.is_none());
    let mut output = BufReader::new(output);
    let ready = line_containing(&mut output, "TTY_READY:").await;
    assert!(ready.contains("TTY_READY:84x21"), "{ready}");
    control
        .resize(112, 37)
        .unwrap_or_else(|error| panic!("resize terminal: {error}"));
    input
        .write_all(b"terminal ping\r\n")
        .await
        .unwrap_or_else(|error| panic!("write terminal input: {error}"));
    let result = line_containing(&mut output, "TTY_RESULT:").await;
    assert!(
        result.contains("TTY_RESULT:terminal ping:112x37"),
        "{result}"
    );
    line_containing(&mut output, "TTY_ERROR").await;
    let drain = tokio::spawn(async move {
        output
            .read_to_end(&mut Vec::new())
            .await
            .unwrap_or_else(|error| panic!("terminal EOF: {error}"))
    });
    assert_eq!(finish(&mut child).await.code(), Some(7));
    tokio::time::timeout(Duration::from_secs(20), drain)
        .await
        .unwrap_or_else(|error| panic!("terminal EOF deadline: {error}"))
        .unwrap_or_else(|error| panic!("terminal drained: {error}"));
    assert!(
        control.resize(80, 24).is_err(),
        "completed terminal identity must be retired"
    );
}

#[tokio::test]
async fn terminating_the_job_kills_the_complete_descendant_tree() {
    let mut child = fixture("tree")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn tree: {error}"));
    let job = child.job();
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "TREE_READY").await;
    assert!(
        job.active_processes()
            .unwrap_or_else(|error| panic!("query job: {error}"))
            >= 2
    );
    job.terminate()
        .unwrap_or_else(|error| panic!("terminate owned job: {error}"));
    finish(&mut child).await;
    tokio::time::timeout(Duration::from_secs(5), output.read_to_end(&mut Vec::new()))
        .await
        .unwrap_or_else(|error| panic!("descendant output closed: {error}"))
        .unwrap_or_else(|error| panic!("read EOF: {error}"));
    assert_eq!(
        job.active_processes()
            .unwrap_or_else(|error| panic!("query empty job: {error}")),
        0
    );
}

#[tokio::test]
async fn dropping_the_job_owner_terminates_its_live_tree() {
    let mut child = fixture("tree")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn owned tree: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "TREE_READY").await;
    drop(child);
    tokio::time::timeout(Duration::from_secs(5), output.read_to_end(&mut Vec::new()))
        .await
        .unwrap_or_else(|error| panic!("dropped tree closed output: {error}"))
        .unwrap_or_else(|error| panic!("read EOF: {error}"));
}

#[tokio::test]
async fn cleared_environments_do_not_reintroduce_ambient_variables() {
    let mut command = fixture("environment");
    command
        .env_clear()
        .env("HAPPY_WINDOWS_TEST_OPERATION", "environment")
        .env("HAPPY_WINDOWS_SELECTED", "selected");
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| panic!("spawn isolated environment: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "ENVIRONMENT_OK").await;
    assert_eq!(finish(&mut child).await.code(), Some(0));
}

#[tokio::test]
async fn arguments_preserve_quotes_backslashes_empty_values_and_unicode() {
    let expected = [
        "",
        "plain",
        "with spaces",
        "a\"b",
        "C:\\with spaces\\",
        "native 🎉",
    ];
    let mut command = fixture("arguments");
    command.arg("--").args(expected);
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| panic!("spawn arguments: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    let line = line_containing(&mut output, "ARGUMENTS:").await;
    let encoded = line
        .split_once("ARGUMENTS:")
        .unwrap_or_else(|| panic!("argument marker"))
        .1
        .trim();
    let actual: Vec<String> =
        serde_json::from_str(encoded).unwrap_or_else(|error| panic!("argument JSON: {error}"));
    assert_eq!(actual, expected);
    assert_eq!(finish(&mut child).await.code(), Some(0));
}

#[tokio::test]
async fn cmd_shell_syntax_keeps_inner_quotes_without_crt_escaping() {
    let mut command = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
    command
        .args(["/d", "/s", "/c"])
        .raw_arg("\"echo \"native ping\"&echo NATIVE_DONE\"");
    let mut child = command
        .spawn()
        .unwrap_or_else(|error| panic!("spawn cmd: {error}"));
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    let line = line_containing(&mut output, "native ping").await;
    assert_eq!(line.trim(), "\"native ping\"");
    line_containing(&mut output, "NATIVE_DONE").await;
    assert_eq!(finish(&mut child).await.code(), Some(0));
}

#[tokio::test]
async fn an_exited_leader_retains_the_job_of_its_surviving_descendant() {
    let mut child = fixture("orphan")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn orphan: {error}"));
    let job = child.job();
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "ORPHAN_READY").await;
    assert_eq!(finish(&mut child).await.code(), Some(0));
    drop(child);
    assert!(
        job.active_processes()
            .unwrap_or_else(|error| panic!("retained job: {error}"))
            >= 1
    );
    job.terminate()
        .unwrap_or_else(|error| panic!("terminate retained job: {error}"));
    tokio::time::timeout(Duration::from_secs(5), output.read_to_end(&mut Vec::new()))
        .await
        .unwrap_or_else(|error| panic!("orphan output closed: {error}"))
        .unwrap_or_else(|error| panic!("orphan EOF: {error}"));
    assert_eq!(
        job.active_processes()
            .unwrap_or_else(|error| panic!("empty retained job: {error}")),
        0
    );
}

#[tokio::test]
async fn abrupt_owner_exit_closes_private_jobs_and_kills_the_tree() {
    let mut child = fixture("owner")
        .spawn()
        .unwrap_or_else(|error| panic!("spawn job owner: {error}"));
    let job = child.job();
    let mut output = BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
    line_containing(&mut output, "OWNER_READY").await;
    child
        .stdin
        .as_mut()
        .unwrap_or_else(|| panic!("stdin"))
        .write_all(b"exit\n")
        .await
        .unwrap_or_else(|error| panic!("exit owner: {error}"));
    assert_eq!(finish(&mut child).await.code(), Some(19));
    tokio::time::timeout(Duration::from_secs(5), async {
        while job
            .active_processes()
            .unwrap_or_else(|error| panic!("query owner tree: {error}"))
            != 0
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|error| panic!("owner death ended nested job: {error}"));
}

#[test]
fn restricted_modes_fail_closed_with_the_boundary_reason() {
    for mode in ["workspace_write", "auto"] {
        let error = super::require_full_access(mode)
            .err()
            .unwrap_or_else(|| panic!("{mode} launched without a boundary"));
        assert!(error.to_string().contains("atomic filename boundary"));
    }
    assert!(
        super::require_full_access("read_only")
            .err()
            .unwrap_or_else(|| panic!("Read only launched without a boundary"))
            .to_string()
            .contains("dedicated-account")
    );
    assert!(super::require_full_access("full_access").is_ok());
    assert!(super::require_full_access("unexpected").is_err());
}

#[test]
fn process_io_progresses_while_the_only_blocking_worker_is_occupied() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap_or_else(|error| panic!("bounded runtime: {error}"));
    runtime.block_on(async {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel::<()>();
        let worker = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = waiting.recv();
        });
        ready
            .await
            .unwrap_or_else(|error| panic!("blocking worker ready: {error}"));
        let check = tokio::time::timeout(Duration::from_secs(20), async {
            let mut child = fixture("echo")
                .spawn()
                .unwrap_or_else(|error| panic!("spawn IOCP echo: {error}"));
            let mut output =
                BufReader::new(child.stdout.take().unwrap_or_else(|| panic!("stdout")));
            line_containing(&mut output, "ECHO_READY").await;
            child
                .stdin
                .as_mut()
                .unwrap_or_else(|| panic!("stdin"))
                .write_all(b"no blocking worker\n")
                .await
                .unwrap_or_else(|error| panic!("IOCP input: {error}"));
            line_containing(&mut output, "ECHO_RESULT:no blocking worker").await;
            assert_eq!(finish(&mut child).await.code(), Some(37));
        })
        .await;
        drop(release);
        worker
            .await
            .unwrap_or_else(|error| panic!("blocking worker ended: {error}"));
        check.unwrap_or_else(|error| panic!("process IO required no blocking worker: {error}"));
    });
}

/// A real child entry point inside this test executable, never a helper binary.
#[test]
fn child_fixture() {
    let Ok(operation) = std::env::var("HAPPY_WINDOWS_TEST_OPERATION") else {
        return;
    };
    match operation.as_str() {
        "echo" => {
            println!("ECHO_READY");
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .unwrap_or_else(|error| panic!("fixture input: {error}"));
            println!("ECHO_RESULT:{}", line.trim());
            eprintln!("ECHO_ERROR");
            std::process::exit(37);
        }
        "burst" => {
            println!("BURST_READY");
            let mut output = std::io::stdout().lock();
            let mut errors = std::io::stderr().lock();
            for index in 0..32_768u32 {
                output
                    .write_all(&index.to_le_bytes())
                    .unwrap_or_else(|error| panic!("fixture stdout: {error}"));
                errors
                    .write_all(&(u32::MAX - index).to_le_bytes())
                    .unwrap_or_else(|error| panic!("fixture stderr: {error}"));
            }
            output
                .flush()
                .unwrap_or_else(|error| panic!("flush fixture output: {error}"));
            errors
                .flush()
                .unwrap_or_else(|error| panic!("flush fixture errors: {error}"));
            std::process::exit(0);
        }
        "terminal" => {
            use windows_sys::Win32::System::Console::{
                CONSOLE_SCREEN_BUFFER_INFO, GetConsoleScreenBufferInfo, GetStdHandle,
                STD_OUTPUT_HANDLE,
            };
            let dimensions = || {
                let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
                assert_ne!(
                    unsafe {
                        GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info)
                    },
                    0
                );
                (info.dwSize.X, info.dwSize.Y)
            };
            let (cols, rows) = dimensions();
            println!("TTY_READY:{cols}x{rows}");
            let mut line = String::new();
            std::io::stdin()
                .read_line(&mut line)
                .unwrap_or_else(|error| panic!("terminal fixture input: {error}"));
            let (cols, rows) = dimensions();
            println!("TTY_RESULT:{}:{cols}x{rows}", line.trim());
            eprintln!("TTY_ERROR");
            std::process::exit(7);
        }
        "tree" => {
            let mut descendant = std::process::Command::new(
                std::env::current_exe()
                    .unwrap_or_else(|error| panic!("fixture executable: {error}")),
            )
            .args(["--exact", "windows::tests::child_fixture", "--nocapture"])
            .env("HAPPY_WINDOWS_TEST_OPERATION", "descendant")
            .spawn()
            .unwrap_or_else(|error| panic!("spawn descendant: {error}"));
            println!("TREE_READY:{}", descendant.id());
            let mut input = Vec::new();
            std::io::stdin()
                .read_to_end(&mut input)
                .unwrap_or_else(|error| panic!("fixture waits for EOF: {error}"));
            descendant
                .wait()
                .unwrap_or_else(|error| panic!("wait fixture descendant: {error}"));
        }
        "descendant" => {
            let mut input = Vec::new();
            std::io::stdin()
                .read_to_end(&mut input)
                .unwrap_or_else(|error| panic!("descendant waits for EOF: {error}"));
        }
        "environment" => {
            assert!(std::env::var_os("PATH").is_none());
            assert!(std::env::var_os("USERPROFILE").is_none());
            assert_eq!(
                std::env::var("HAPPY_WINDOWS_SELECTED")
                    .unwrap_or_else(|error| panic!("selected variable: {error}")),
                "selected"
            );
            println!("ENVIRONMENT_OK");
            std::process::exit(0);
        }
        "arguments" => {
            let arguments: Vec<_> = std::env::args()
                .skip_while(|arg| arg != "--")
                .skip(1)
                .collect();
            println!(
                "ARGUMENTS:{}",
                serde_json::to_string(&arguments)
                    .unwrap_or_else(|error| panic!("encode arguments: {error}"))
            );
            std::process::exit(0);
        }
        "orphan" => {
            let descendant = std::process::Command::new(
                std::env::current_exe()
                    .unwrap_or_else(|error| panic!("fixture executable: {error}")),
            )
            .args(["--exact", "windows::tests::child_fixture", "--nocapture"])
            .env("HAPPY_WINDOWS_TEST_OPERATION", "persistent_descendant")
            .spawn()
            .unwrap_or_else(|error| panic!("spawn orphan descendant: {error}"));
            println!("ORPHAN_READY:{}", descendant.id());
            // This fixture deliberately exits without running destructors. The
            // retained Job must continue to own the live descendant.
            std::process::exit(0);
        }
        "persistent_descendant" => loop {
            std::thread::park();
        },
        "owner" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|error| panic!("owner runtime: {error}"));
            let _owned = runtime.block_on(async {
                let mut nested = fixture("tree")
                    .spawn()
                    .unwrap_or_else(|error| panic!("spawn nested job: {error}"));
                let mut output = BufReader::new(
                    nested
                        .stdout
                        .take()
                        .unwrap_or_else(|| panic!("nested stdout")),
                );
                line_containing(&mut output, "TREE_READY").await;
                nested
            });
            println!("OWNER_READY");
            let mut input = String::new();
            std::io::stdin()
                .read_line(&mut input)
                .unwrap_or_else(|error| panic!("owner input: {error}"));
            // OS handle closure, rather than Child/Job Drop, owns this cleanup.
            std::process::exit(19);
        }
        _ => panic!("unexpected fixture operation"),
    }
}
