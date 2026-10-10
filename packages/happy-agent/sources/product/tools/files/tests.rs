use super::*;

#[cfg(unix)]
#[tokio::test]
async fn native_runner_filesystem_matches_source_rpc_shapes_and_per_call_boundaries() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new().await;
    let request = json!({"computeId":"peer-files","cwd":fixture.root,"policy":{"protectedProjectFiles":["owner-rule"]}});
    let filesystem = fixture.files.runner_filesystem(&request).unwrap();
    let cancel = CancellationToken::new();
    let permissions =
        json!({"mode":"workspace_write","network":{"egress":false,"localBinding":false}});
    let call = |path: &str| json!({"computeId":"peer-files","permissions":permissions,"path":path});
    let mut mkdir = call("nested");
    mkdir["recursive"] = json!(true);
    assert_eq!(
        filesystem
            .native_runner_request("fs.mkdir", &mkdir, &[], &cancel)
            .await
            .unwrap()
            .0,
        json!({})
    );
    let mut write = call("nested/data");
    write["encoding"] = json!("bytes");
    let body = b"\x00raw\xff\n";
    filesystem
        .native_runner_request("fs.writeFile", &write, body, &cancel)
        .await
        .unwrap();
    let mut read = call("nested/data");
    read["maxBytes"] = json!(body.len());
    assert_eq!(
        filesystem
            .native_runner_request("fs.readFileBuffer", &read, &[], &cancel)
            .await
            .unwrap(),
        (json!({}), body.to_vec())
    );
    assert_eq!(
        filesystem
            .native_runner_request("fs.readFile", &read_without_options(&read), &[], &cancel)
            .await
            .unwrap()
            .0,
        json!({"text":"\u{0}raw�\n"})
    );
    let stat = filesystem
        .native_runner_request("fs.stat", &call("nested/data"), &[], &cancel)
        .await
        .unwrap()
        .0;
    assert_eq!(stat["stat"]["size"], body.len());
    assert_eq!(stat["stat"]["isFile"], true);
    let mut chmod = call("nested/data");
    chmod["mode"] = json!(0o751);
    filesystem
        .native_runner_request("fs.chmod", &chmod, &[], &cancel)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(fixture.root.join("nested/data"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o751
    );
    let mut modified = call("nested/data");
    modified["mtimeMs"] = json!(123456789000.0);
    filesystem
        .native_runner_request("fs.setModificationTime", &modified, &[], &cancel)
        .await
        .unwrap();
    let stat = filesystem
        .native_runner_request("fs.lstat", &call("nested/data"), &[], &cancel)
        .await
        .unwrap()
        .0;
    assert_eq!(stat["stat"]["mtimeMs"], 123456789000.0);
    std::fs::write(fixture.root.join("occupied"), "replace").unwrap();
    let move_request = json!({"computeId":"peer-files","permissions":permissions,"source":"nested/data","destination":"occupied"});
    filesystem
        .native_runner_request("fs.move", &move_request, &[], &cancel)
        .await
        .unwrap();
    assert_eq!(std::fs::read(fixture.root.join("occupied")).unwrap(), body);
    std::os::unix::fs::symlink("missing", fixture.root.join("dangling")).unwrap();
    assert_eq!(
        filesystem
            .native_runner_request("fs.exists", &call("dangling"), &[], &cancel)
            .await
            .unwrap()
            .0,
        json!({"exists":true})
    );
    assert!(
        filesystem
            .native_runner_request("fs.stat", &call("dangling"), &[], &cancel)
            .await
            .is_err()
    );
    assert_eq!(
        filesystem
            .native_runner_request("fs.lstat", &call("dangling"), &[], &cancel)
            .await
            .unwrap()
            .0["stat"]["isSymbolicLink"],
        true
    );
    let batch =
        json!({"computeId":"peer-files","permissions":permissions,"paths":["occupied","missing"]});
    let stats = filesystem
        .native_runner_request("fs.lstatMany", &batch, &[], &cancel)
        .await
        .unwrap()
        .0;
    assert_eq!(stats["stats"][1], Value::Null);
    let page = json!({"computeId":"peer-files","permissions":permissions,"path":".","limit":1});
    assert_eq!(
        filesystem
            .native_runner_request("fs.readdirPage", &page, &[], &cancel)
            .await
            .unwrap()
            .0,
        json!({"entries":["dangling"],"hasMore":true})
    );
    assert_eq!(
        filesystem
            .native_runner_request("fs.readdir", &call("nested"), &[], &cancel)
            .await
            .unwrap()
            .0,
        json!({"entries":[]})
    );
    assert_eq!(
        filesystem
            .native_runner_request("fs.realpath", &call("occupied"), &[], &cancel)
            .await
            .unwrap()
            .0["path"],
        fixture.root.join("occupied").to_str().unwrap()
    );
    for protected in ["happy.toml", "owner-rule", ".git/config"] {
        let mut blocked = call(protected);
        blocked["encoding"] = json!("bytes");
        assert!(
            filesystem
                .native_runner_request("fs.writeFile", &blocked, b"forbidden", &cancel)
                .await
                .is_err()
        );
        assert!(!fixture.root.join(protected).exists());
    }
    let mut read_only = write.clone();
    read_only["permissions"]["mode"] = json!("read_only");
    assert!(
        filesystem
            .native_runner_request("fs.writeFile", &read_only, b"forbidden", &cancel)
            .await
            .is_err()
    );
    let mut denied = call("occupied");
    denied["permissions"]["mode"] = json!("full_access");
    denied["permissions"]["deniedReadPaths"] = json!(["occupied"]);
    assert!(
        filesystem
            .native_runner_request("fs.readFile", &denied, &[], &cancel)
            .await
            .is_err()
    );
    let mut remove = call("nested");
    remove["recursive"] = json!(true);
    remove["force"] = json!(true);
    filesystem
        .native_runner_request("fs.rm", &remove, &[], &cancel)
        .await
        .unwrap();
    filesystem
        .native_runner_request("fs.rm", &remove, &[], &cancel)
        .await
        .unwrap();
    fixture.close().await;
}

fn read_without_options(read: &Value) -> Value {
    let mut read = read.clone();
    read.as_object_mut().unwrap().remove("maxBytes");
    read
}

#[tokio::test]
async fn compute_directory_pages_preserve_source_byte_order_and_cursor() {
    let fixture = Fixture::new().await;
    for name in ["\u{e000}", "\u{10000}", "plain"] {
        std::fs::write(fixture.root.join(name), "data").unwrap();
    }
    let filesystem = fixture
        .files
        .filesystem(&fixture.configuration, "read_only")
        .unwrap();
    let cancel = CancellationToken::new();
    let first = filesystem
        .entries(&fixture.root, None, 2, &cancel)
        .await
        .unwrap();
    assert_eq!(
        first,
        json!({"entries":["plain","\u{e000}"],"hasMore":true})
    );
    assert_eq!(
        filesystem
            .entries(&fixture.root, Some("\u{e000}"), 2, &cancel)
            .await
            .unwrap(),
        json!({"entries":["\u{10000}"],"hasMore":false})
    );
    fixture.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn patches_remember_the_written_alias_for_later_staleness_checks() {
    let fixture = Fixture::new().await;
    let target = fixture.root.join("kept.txt");
    std::fs::write(&target, "before\n").unwrap();
    let alias = fixture.root.join("alias.txt");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    let cancel = CancellationToken::new();
    let result=fixture.files.patch("sourcefiles",&fixture.configuration,"workspace_write",&json!({"patch":"*** Begin Patch\n*** Update File: alias.txt\n@@\n-before\n+after\n*** End Patch"}),&cancel).await.unwrap();
    let stamp = result.read.as_ref().unwrap()[0].clone();
    let files = fixture.files.clone();
    fixture
        .runtime
        .transact(move |ctx| files.record(ctx, "sourcefiles", &stamp))
        .await
        .unwrap();
    let old = std::fs::metadata(&target).unwrap().modified().unwrap();
    std::fs::write(&target, "external\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&target)
        .unwrap()
        .set_modified(old + std::time::Duration::from_secs(2))
        .unwrap();
    assert!(
        fixture
            .files
            .edit(
                "sourcefiles",
                &fixture.configuration,
                "workspace_write",
                "claude",
                &json!({"file_path":alias,"old_string":"external","new_string":"discarded"}),
                &cancel
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(target).unwrap(), "external\n");
    fixture.close().await;
}

#[tokio::test]
async fn content_search_uses_javascript_lookaround_backreferences_and_utf16_matching() {
    let fixture = Fixture::new().await;
    std::fs::write(
        fixture.root.join("patterns.txt"),
        "prefix:needle;\nab ab\n😀\n",
    )
    .unwrap();
    let cancel = CancellationToken::new();
    for pattern in ["(?<=prefix:)needle(?=;)", r"\b(\w+)\s+\1\b"] {
        let result = fixture
            .files
            .discover(
                &fixture.configuration,
                "workspace_write",
                "claude",
                "Grep",
                &json!({"pattern":pattern,"output_mode":"content"}),
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(result.value["match_count"], 1, "{pattern}");
    }
    let result = fixture
        .files
        .discover(
            &fixture.configuration,
            "workspace_write",
            "kimi",
            "Grep",
            &json!({"path":"patterns.txt","pattern":"[^a-z :;]","output_mode":"count_matches"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(result.value["match_count"], 2);
    fixture.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn patch_deletes_the_symbolic_link_entry_and_keeps_its_destination() {
    let fixture = Fixture::new().await;
    let target = fixture.root.join("kept.txt");
    std::fs::write(&target, "keep this destination\n").unwrap();
    let link = fixture.root.join("link.txt");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let cancel = CancellationToken::new();
    fixture
        .files
        .patch(
            "sourcefiles",
            &fixture.configuration,
            "full_access",
            &json!({"patch":"*** Begin Patch\n*** Delete File: link.txt\n*** End Patch"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "keep this destination\n"
    );
    assert!(std::fs::symlink_metadata(link).is_err());
    fixture.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn patch_moves_keep_executable_permissions_and_refuse_an_occupied_destination() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = Fixture::new().await;
    let source = fixture.root.join("run.sh");
    std::fs::write(&source, "before\n").unwrap();
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o751)).unwrap();
    let cancel = CancellationToken::new();
    fixture.files.patch("sourcefiles",&fixture.configuration,"workspace_write",&json!({"patch":"*** Begin Patch\n*** Update File: run.sh\n*** Move to: nested/moved.sh\n@@\n-before\n+after\n*** End Patch"}),&cancel).await.unwrap();
    let moved = fixture.root.join("nested/moved.sh");
    assert!(!source.exists());
    assert_eq!(std::fs::read_to_string(&moved).unwrap(), "after\n");
    assert_eq!(std::fs::metadata(&moved).unwrap().mode() & 0o777, 0o751);
    std::fs::write(fixture.root.join("occupied.sh"), "keep\n").unwrap();
    assert!(fixture.files.patch("sourcefiles",&fixture.configuration,"workspace_write",&json!({"patch":"*** Begin Patch\n*** Update File: nested/moved.sh\n*** Move to: occupied.sh\n@@\n-after\n+changed\n*** End Patch"}),&cancel).await.is_err());
    assert_eq!(std::fs::read_to_string(&moved).unwrap(), "after\n");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("occupied.sh")).unwrap(),
        "keep\n"
    );
    fixture.close().await;
}

/// The planner refuses an occupied destination first, so this drives the commit directly: a
/// destination that appears after planning must stop the move inside the kernel, not replace it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn native_moves_refuse_a_destination_that_appears_after_planning() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.txt");
    let destination = directory.path().join("destination.txt");
    std::fs::write(&source, "moved\n").unwrap();
    let expected = std::fs::symlink_metadata(&source).unwrap();
    std::fs::write(&destination, "keep\n").unwrap();
    let error = native::move_file(&source, &destination, &expected).unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("The move could not commit without overwriting another file: "),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&source).unwrap(), "moved\n");
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "keep\n");
    std::fs::remove_file(&destination).unwrap();
    native::move_file(&source, &destination, &expected).unwrap();
    assert!(!source.exists());
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "moved\n");
}

struct Fixture {
    directory: tempfile::TempDir,
    root: PathBuf,
    runtime: Arc<RuntimeModule>,
    files: Arc<Files>,
    configuration: Value,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let files = Arc::new(Files::new(config, runtime.clone()).unwrap());
        let configuration = json!({"modules":{"compute":{"cwd":root}}});
        Self {
            directory,
            root,
            runtime,
            files,
            configuration,
        }
    }
    async fn record(&self, agent: &str, result: &FileResult) {
        let read = result.read.clone().unwrap();
        let files = self.files.clone();
        let agent = agent.to_owned();
        self.runtime
            .transact(move |ctx| files.record(ctx, &agent, &read))
            .await
            .unwrap();
    }
    async fn close(&self) {
        self.runtime.close().await.unwrap();
    }
}

#[tokio::test]
async fn private_installation_files_are_denied_in_full_access_and_excluded_from_recursive_search() {
    let fixture = Fixture::new().await;
    let private = fixture
        .directory
        .path()
        .join(".happy/agent/private-marker.txt");
    std::fs::write(&private, "needle private credential").unwrap();
    let cancel = CancellationToken::new();
    assert!(
        fixture
            .files
            .read(
                &fixture.configuration,
                "full_access",
                "claude",
                &json!({"file_path":private}),
                false,
                &cancel
            )
            .await
            .is_err()
    );
    assert!(
        fixture
            .files
            .write(
                "sourcefiles",
                &fixture.configuration,
                "full_access",
                "claude",
                &json!({"file_path":private,"content":"replace private"}),
                &cancel
            )
            .await
            .is_err()
    );
    #[cfg(unix)]
    {
        let alias = fixture.root.join("private-alias");
        std::os::unix::fs::symlink(private.parent().unwrap(), &alias).unwrap();
        assert!(
            fixture
                .files
                .read(
                    &fixture.configuration,
                    "full_access",
                    "claude",
                    &json!({"file_path":alias.join("private-marker.txt")}),
                    false,
                    &cancel
                )
                .await
                .is_err()
        );
    }
    let result = fixture
        .files
        .discover(
            &fixture.configuration,
            "full_access",
            "grok",
            "grep",
            &json!({"path":fixture.directory.path(),"pattern":"needle"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(result.value["matched_files"], 0);
    assert_eq!(
        std::fs::read_to_string(private).unwrap(),
        "needle private credential"
    );
    fixture.close().await;
}

#[tokio::test]
async fn remembered_file_changes_reject_edits_and_read_stamps_roll_back_with_the_caller() {
    let fixture = Fixture::new().await;
    let path = fixture.root.join("app.ts");
    std::fs::write(&path, "const a = 1;\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::new(1_791_615_436, 209_500))
        .unwrap();
    let cancel = CancellationToken::new();
    let read = fixture
        .files
        .read(
            &fixture.configuration,
            "workspace_write",
            "claude",
            &json!({"file_path":path}),
            false,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(read.value["content"], "1\tconst a = 1;\n2\t");
    let files = fixture.files.clone();
    let stamp = read.read.clone().unwrap();
    let rolled_back = fixture
        .runtime
        .transact(move |ctx| -> Result<()> {
            files.record(ctx, "sourcefiles", &stamp)?;
            anyhow::bail!("roll back the whole tool result")
        })
        .await;
    assert!(rolled_back.is_err());
    let absent = fixture
        .runtime
        .transact(|ctx| ctx.value("sourcefiles", "kv.sourcefiles.module.compute.reads"))
        .await
        .unwrap();
    assert!(absent.is_none());
    fixture.record("sourcefiles", &read).await;
    let unchanged = fixture
        .files
        .edit(
            "sourcefiles",
            &fixture.configuration,
            "workspace_write",
            "claude",
            &json!({"file_path":path,"old_string":"1","new_string":"2"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "const a = 2;\n");
    assert_eq!(unchanged.value["presentation"]["type"], "file_diff");
    let old = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, "const a = 99;\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(old + std::time::Duration::from_secs(2))
        .unwrap();
    let error = fixture
        .files
        .edit(
            "sourcefiles",
            &fixture.configuration,
            "workspace_write",
            "claude",
            &json!({"file_path":path,"old_string":"99","new_string":"3"}),
            &cancel,
        )
        .await
        .err()
        .unwrap();
    assert!(error.to_string().contains("changed since it was last read"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "const a = 99;\n");
    fixture.close().await;
}

#[tokio::test]
async fn mutations_share_the_real_boundary_preserve_modes_and_leave_protected_absences_untouched() {
    let fixture = Fixture::new().await;
    let outside = fixture.directory.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let cancel = CancellationToken::new();
    for path in [
        "happy.toml",
        "mcp.toml",
        "AGENTS_SECURITY.md",
        ".git/config",
    ] {
        let result = fixture
            .files
            .write(
                "sourcefiles",
                &fixture.configuration,
                "workspace_write",
                "claude",
                &json!({"file_path":path,"content":"blocked","dangerouslyDisableSandbox":true}),
                &cancel,
            )
            .await;
        assert!(result.is_err(), "{path}");
        assert!(!fixture.root.join(path).exists());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, fixture.root.join("escape")).unwrap();
        assert!(
            fixture
                .files
                .write(
                    "sourcefiles",
                    &fixture.configuration,
                    "workspace_write",
                    "grok",
                    &json!({"file_path":"escape/new.txt","content":"blocked"}),
                    &cancel
                )
                .await
                .is_err()
        );
        assert!(!outside.join("new.txt").exists());
    }
    let ordinary = fixture
        .files
        .write(
            "sourcefiles",
            &fixture.configuration,
            "workspace_write",
            "grok",
            &json!({"file_path":"rig.toml","content":"ordinary project file"}),
            &cancel,
        )
        .await
        .unwrap();
    assert!(ordinary.value["created"] == true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let path = fixture.root.join("executable.sh");
        std::fs::write(&path, "before").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();
        fixture
            .files
            .write(
                "sourcefiles",
                &fixture.configuration,
                "workspace_write",
                "claude",
                &json!({"file_path":path,"content":"after"}),
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o751);
    }
    assert!(fixture.files.write("sourcefiles",&fixture.configuration,"read_only","claude",&json!({"file_path":"readonly.txt","content":"blocked","dangerouslyDisableSandbox":true}),&cancel).await.is_err());
    assert!(!fixture.root.join("readonly.txt").exists());
    fixture.close().await;
}

#[tokio::test]
async fn exact_edits_without_a_prior_read_reject_ambiguity_and_report_bounded_exact_totals() {
    let fixture = Fixture::new().await;
    let path = fixture.root.join("large.txt");
    std::fs::write(
        &path,
        (0..600).map(|_| "old").collect::<Vec<_>>().join("\n"),
    )
    .unwrap();
    let cancel = CancellationToken::new();
    assert!(
        fixture
            .files
            .edit(
                "sourcefiles",
                &fixture.configuration,
                "workspace_write",
                "claude",
                &json!({"file_path":path,"old_string":"old","new_string":"new"}),
                &cancel
            )
            .await
            .is_err()
    );
    let changed = fixture
        .files
        .edit(
            "sourcefiles",
            &fixture.configuration,
            "workspace_write",
            "claude",
            &json!({"file_path":path,"old_string":"old","new_string":"new","replace_all":true}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(changed.value["replacements"], 600);
    let diff = &changed.value["presentation"]["files"][0];
    assert_eq!(diff["added"], 600);
    assert_eq!(diff["deleted"], 600);
    assert_eq!(diff["omittedLines"], 700);
    assert!(
        fixture
            .files
            .schemas
            .valid(
                "computeFileDiffPresentation",
                &changed.value["presentation"]
            )
            .unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(&path)
            .unwrap()
            .matches("new")
            .count(),
        600
    );
    fixture.close().await;
}

#[tokio::test]
async fn patch_simulation_precedes_all_writes_and_preserves_crlf_and_final_newlines() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.root.join("one.txt"), "first\r\nlast\r\n").unwrap();
    std::fs::write(fixture.root.join("two.txt"), "second\n").unwrap();
    let cancel = CancellationToken::new();
    let patch = "*** Begin Patch\n*** Update File: one.txt\n@@\n-first\n+changed\n*** Update File: two.txt\n@@\n-missing context\n+new\n*** End Patch";
    assert!(
        fixture
            .files
            .patch(
                "sourcefiles",
                &fixture.configuration,
                "workspace_write",
                &json!({"patch":patch}),
                &cancel
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("one.txt")).unwrap(),
        "first\r\nlast\r\n"
    );
    let result=fixture.files.patch("sourcefiles",&fixture.configuration,"workspace_write",&json!({"patch":"*** Begin Patch\n*** Update File: one.txt\n@@\n-first\n+changed\n*** Add File: new.txt\n+new file\n*** End Patch"}),&cancel).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("one.txt")).unwrap(),
        "changed\r\nlast\r\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("new.txt")).unwrap(),
        "new file"
    );
    assert_eq!(result.value["changes"].as_array().unwrap().len(), 2);
    assert!(
        fixture
            .files
            .schemas
            .valid("computeFileDiffPresentation", &result.value["presentation"])
            .unwrap()
    );
    fixture.close().await;
}

#[tokio::test]
async fn kimi_fragmented_reads_resume_at_utf16_boundaries_and_edits_keep_the_pure_crlf_view() {
    let fixture = Fixture::new().await;
    let path = fixture.root.join("text.txt");
    std::fs::write(&path, "😀".repeat(800)).unwrap();
    let cancel = CancellationToken::new();
    let read = fixture
        .files
        .kimi_read(
            &fixture.configuration,
            "workspace_write",
            &json!({"path":path,"max_chars":1024}),
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        read.value["text"]
            .as_str()
            .unwrap()
            .contains("\"column_offset\":510")
    );
    assert!(read.value["truncated"] == true);
    assert!(
        fixture
            .files
            .kimi_read(
                &fixture.configuration,
                "workspace_write",
                &json!({"path":path,"column_offset":1}),
                &cancel
            )
            .await
            .is_err()
    );
    let resumed = fixture
        .files
        .kimi_read(
            &fixture.configuration,
            "workspace_write",
            &json!({"path":path,"line_offset":1,"column_offset":510,"max_chars":5000}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        resumed.value["text"]
            .as_str()
            .unwrap()
            .matches('😀')
            .count(),
        545
    );
    assert!(resumed.value["truncated"] == false);
    std::fs::write(&path, "\u{feff}first\r\nsecond\r\n").unwrap();
    let edited = fixture
        .files
        .edit(
            "sourcefiles",
            &fixture.configuration,
            "workspace_write",
            "kimi",
            &json!({"path":path,"old_string":"first\nsecond","new_string":"changed\nsecond"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(edited.value["replacements"], 1);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "\u{feff}changed\r\nsecond\r\n"
    );
    fixture.close().await;
}

#[tokio::test]
async fn discovery_respects_parent_ignore_rules_and_skips_symbolic_links_without_losing_nested_files()
 {
    let fixture = Fixture::new().await;
    std::fs::create_dir(fixture.root.join(".git")).unwrap();
    std::fs::create_dir(fixture.root.join("src")).unwrap();
    std::fs::create_dir(fixture.root.join("src/ignored")).unwrap();
    std::fs::write(fixture.root.join(".gitignore"), "ignored/\n").unwrap();
    std::fs::write(
        fixture.root.join("src/a.ts"),
        "const needle = 1;\nconst tail = 2;\n",
    )
    .unwrap();
    std::fs::write(
        fixture.root.join("src/ignored/hidden.ts"),
        "needle in ignored file",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture.root.join("src"), fixture.root.join("cycle")).unwrap();
    let cancel = CancellationToken::new();
    let grep = fixture
        .files
        .discover(
            &fixture.configuration,
            "workspace_write",
            "grok",
            "grep",
            &json!({"path":"src","pattern":"needle","-A":1}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(grep.value["matched_files"], 1);
    assert!(
        grep.value["text"]
            .as_str()
            .unwrap()
            .contains("const tail = 2;")
    );
    assert!(!grep.value["text"].as_str().unwrap().contains("hidden.ts"));
    let glob = fixture
        .files
        .discover(
            &fixture.configuration,
            "workspace_write",
            "kimi",
            "Glob",
            &json!({"pattern":"*.ts"}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(glob.value["files"].as_array().unwrap().len(), 2);
    assert!(
        glob.value["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|path| !path.as_str().unwrap().contains("cycle"))
    );
    fixture.close().await;
}

#[tokio::test]
async fn image_reads_keep_original_codex_bytes_and_fit_claude_dimensions_with_the_right_media_type()
{
    use base64::Engine;
    let fixture = Fixture::new().await;
    let path = fixture.root.join("large.jpg");
    let image = image::DynamicImage::new_rgb8(2400, 1350);
    let mut source = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut source, 85)
        .encode_image(&image)
        .unwrap();
    let source = source.into_inner();
    std::fs::write(&path, &source).unwrap();
    let cancel = CancellationToken::new();
    let original = fixture
        .files
        .read(
            &fixture.configuration,
            "workspace_write",
            "codex",
            &json!({"path":path,"detail":"original"}),
            true,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(original.value["image"]["data"].as_str().unwrap())
            .unwrap(),
        source
    );
    assert!(original.value["image"].get("resized").is_none());
    let fitted = fixture
        .files
        .read(
            &fixture.configuration,
            "workspace_write",
            "claude",
            &json!({"file_path":path}),
            false,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(fitted.value["image"]["mime_type"], "image/jpeg");
    assert_eq!(fitted.value["image"]["resized"]["width"], 2000);
    assert_eq!(fitted.value["image"]["resized"]["height"], 1125);
    let delivered = base64::engine::general_purpose::STANDARD
        .decode(fitted.value["image"]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        image::ImageReader::new(std::io::Cursor::new(delivered))
            .with_guessed_format()
            .unwrap()
            .into_dimensions()
            .unwrap(),
        (2000, 1125)
    );
    fixture.close().await;
}
