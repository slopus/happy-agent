use super::*;
use crate::product::owners::Fixture;
use base64::{Engine, engine::general_purpose::STANDARD};

fn comparable_project(mut value: Value) -> Value {
    value.as_object_mut().unwrap().remove("updatedAt");
    value
}
fn comparable_event(mut value: Value) -> Value {
    value.as_object_mut().unwrap().remove("eventId");
    value.as_object_mut().unwrap().remove("at");
    value["project"] = comparable_project(value["project"].clone());
    if value.get("previousProject").is_some() {
        value["previousProject"] = comparable_project(value["previousProject"].clone());
    }
    value
}

#[tokio::test]
async fn source_project_edits_preserve_noops_versions_assets_and_exact_transactional_events() {
    let fixture = Fixture::new().await;
    let owner = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    owner.load().await.unwrap();
    let source: Value = serde_json::from_str(include_str!("project_edit_goldens.json")).unwrap();
    let projects = owner.clone();
    let initial = source["initial"].clone();
    fixture
        .runtime
        .transact(move |ctx| {
            for record in initial.as_array().unwrap() {
                persistence::insert(ctx, &projects.schemas, record)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let collected = observed.clone();
    let weak_owner = Arc::downgrade(&owner);
    let _subscription = owner
        .on_event_transactional(Arc::new(move |ctx, event| {
            let owner = weak_owner.upgrade().unwrap();
            assert_eq!(
                owner
                    .get(ctx, event["project"]["id"].as_str().unwrap())?
                    .as_ref(),
                Some(&event["project"])
            );
            assert_eq!(
                event["project"]["version"].as_u64(),
                event["previousProject"]["version"]
                    .as_u64()
                    .map(|version| version + 1)
            );
            collected
                .lock()
                .unwrap()
                .push(comparable_event(event.clone()));
            Ok(())
        }))
        .unwrap();
    for case in source["cases"].as_array().unwrap() {
        let case = case.clone();
        let projects = owner.clone();
        let asset_data = source["asset"].clone();
        let before_count = observed.lock().unwrap().len();
        let expected_events = case["events"].clone();
        fixture
            .runtime
            .transact(move |ctx| {
                let input = &case["input"];
                let id = input["projectId"].as_str().unwrap();
                let expected = input["expectedVersion"].as_u64().unwrap();
                let result = match case["kind"].as_str().unwrap() {
                    "rename" => {
                        projects.rename(ctx, id, input["name"].as_str().unwrap(), expected)?
                    }
                    "settings" => {
                        projects.update_settings(ctx, id, &input["settings"], expected)?
                    }
                    "reorder" => projects.reorder(ctx, id, input["afterId"].as_str(), expected)?,
                    "set_avatar" => {
                        let asset = AvatarAsset {
                            bytes: STANDARD.decode(asset_data["bytes"].as_str().unwrap())?,
                            metadata: asset_data["metadata"].clone(),
                        };
                        let result = projects.set_avatar(
                            ctx,
                            id,
                            &asset,
                            input["source"].as_str().unwrap(),
                            expected,
                        )?;
                        let read = projects.avatar_asset(ctx, id)?.unwrap();
                        assert_eq!(read.bytes, asset.bytes);
                        assert_eq!(read.metadata, asset.metadata);
                        result
                    }
                    "clear_avatar" => {
                        let result = projects.clear_avatar(ctx, id, expected)?;
                        assert!(projects.avatar_asset(ctx, id)?.is_none());
                        result
                    }
                    _ => unreachable!("The Source capture uses known catalog operations."),
                };
                assert_eq!(comparable_project(result), case["result"]);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            json!(observed.lock().unwrap()[before_count..]),
            expected_events
        );
    }
    let projects = owner.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            let error = projects
                .rename(ctx, "project-1", "Stale rename", 2)
                .unwrap_err();
            let Some(ProjectError::Conflict(current)) = error.downcast_ref::<ProjectError>() else {
                panic!("The version conflict must retain the current record: {error:#}");
            };
            assert_eq!(comparable_project(current.clone()), source["conflict"]);
            for original in source["initial"].as_array().unwrap().iter().skip(1) {
                assert_eq!(
                    projects
                        .get(ctx, original["id"].as_str().unwrap())?
                        .as_ref(),
                    Some(original)
                );
            }
            for case in source["orderCases"].as_array().unwrap() {
                assert_eq!(
                    projects.order_key_between(case["before"].as_str(), case["after"].as_str())?,
                    case["result"]
                );
            }
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn failed_project_observer_rolls_back_settings_row_version_and_image_bytes() {
    let fixture = Fixture::new().await;
    let owner = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    owner.load().await.unwrap();
    let source: Value = serde_json::from_str(include_str!("project_edit_goldens.json")).unwrap();
    let projects = owner.clone();
    let original = source["initial"][0].clone();
    fixture
        .runtime
        .transact(move |ctx| persistence::insert(ctx, &projects.schemas, &original))
        .await
        .unwrap();
    let subscription = owner
        .on_event_transactional(Arc::new(|_ctx, _event| {
            anyhow::bail!("Reject the catalog observer transaction.")
        }))
        .unwrap();
    let projects = owner.clone();
    let failure = fixture
        .runtime
        .transact(move |ctx| {
            projects.update_settings(
                ctx,
                "project-1",
                &json!({"workspaceInitialPrompt":"An atomic change."}),
                2,
            )
        })
        .await;
    assert!(failure.is_err());
    let projects = owner.clone();
    let asset_capture = source["asset"].clone();
    let failure = fixture
        .runtime
        .transact(move |ctx| {
            let asset = AvatarAsset {
                bytes: STANDARD.decode(asset_capture["bytes"].as_str().unwrap())?,
                metadata: asset_capture["metadata"].clone(),
            };
            projects.set_avatar(ctx, "project-1", &asset, "user", 2)
        })
        .await;
    assert!(failure.is_err());
    drop(subscription);
    fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.get(ctx, "project-1")?,
                Some(source["initial"][0].clone())
            );
            assert_eq!(owner.read_settings(ctx, "project-1")?, json!({}));
            assert!(owner.avatar_asset(ctx, "project-1")?.is_none());
            let assets: i64 = ctx.database().query_row(
                "SELECT count(*) FROM happy_agent_module_project_avatars",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(assets, 0);
            // Dropping a subscription removes it from later writes.
            assert_eq!(
                owner.rename(ctx, "project-1", "A committed rename", 2)?["version"],
                3
            );
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}
