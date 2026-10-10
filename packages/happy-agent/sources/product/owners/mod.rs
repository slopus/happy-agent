mod global_skills;
mod node;
mod persistence;
mod runners;
mod git;
mod abort;

pub use global_skills::{GlobalSkillsError, GlobalSkillsModule};
pub use node::NodeModule;
pub use runners::{RunnersModule, RunnerCompute, RunnerProcess, RunnerTransport, RunOptions, RunResult};
pub use git::GitModule;
pub use abort::AbortModule;
#[cfg(test)]
pub(crate) use tests::Fixture;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::{
        config::ConfigModule, durable::DurableFunctionsModule, events::EventsModule,
        lifecycle::LifecycleModule, runtime::RuntimeModule,
    };
    use anyhow::Result;
    use std::{sync::Arc, time::Duration};

    pub struct Fixture {
        pub directory: tempfile::TempDir,
        pub config: Arc<ConfigModule>,
        pub runtime: Arc<RuntimeModule>,
        pub lifecycle: Arc<LifecycleModule>,
        pub durable: Arc<DurableFunctionsModule>,
        pub events: Arc<EventsModule>,
        pub node: Arc<NodeModule>,
        pub skills: Arc<GlobalSkillsModule>,
        workflow_worker: Option<std::path::PathBuf>,
    }
    impl Fixture {
        pub async fn new() -> Self {
            let directory = tempfile::tempdir().expect("isolated owner installation");
            let config = Arc::new(
                ConfigModule::isolated(&directory.path().join(".happy")).expect("configuration"),
            );
            let (runtime, lifecycle, durable, events, node, skills) =
                Self::open(config.clone()).await;
            Self {
                directory,
                config,
                runtime,
                lifecycle,
                durable,
                events,
                node,
                skills,
                workflow_worker: None,
            }
        }
        pub async fn workflow(worker:std::path::PathBuf,endpoint:&str)->Self{
            let directory=tempfile::tempdir().expect("isolated workflow installation");
            let initial=ConfigModule::isolated(&directory.path().join(".happy")).unwrap();
            std::fs::create_dir_all(&initial.paths.configuration).unwrap();
            std::fs::write(initial.paths.configuration.join("happy.toml"),format!("[features]\nworkflows = true\n[providers.fixture]\ntype = \"codex\"\nenabled = true\napi_key = \"fixture-only-token\"\ncredential_isolation = true\nbase_url = \"{endpoint}\"\ntransport = \"sse\"\n")).unwrap();
            let mut config=ConfigModule::isolated(&directory.path().join(".happy")).unwrap();
            config.set_workflow_test_executable(worker.clone());
            let config=Arc::new(config);
            let(runtime,lifecycle,durable,events,node,skills)=Self::open(config.clone()).await;
            Self{directory,config,runtime,lifecycle,durable,events,node,skills,workflow_worker:Some(worker)}
        }
        async fn open(
            config: Arc<ConfigModule>,
        ) -> (
            Arc<RuntimeModule>,
            Arc<LifecycleModule>,
            Arc<DurableFunctionsModule>,
            Arc<EventsModule>,
            Arc<NodeModule>,
            Arc<GlobalSkillsModule>,
        ) {
            let runtime = Arc::new(RuntimeModule::new(config.clone()));
            runtime.load().await.expect("canonical database ownership");
            let lifecycle = Arc::new(LifecycleModule::new(config.clone()).expect("root lifetime"));
            let durable = Arc::new(
                DurableFunctionsModule::new(runtime.clone(), lifecycle.clone())
                    .expect("durable procedures"),
            );
            durable.load().await.expect("original durable migration");
            let events = Arc::new(EventsModule::new(runtime.clone()).expect("events"));
            events.load().await.expect("events migration");
            let node = NodeModule::new(
                config.clone(),
                runtime.clone(),
                durable.clone(),
                events.clone(),
            )
            .expect("real node owner");
            let skills =
                GlobalSkillsModule::new(config, runtime.clone(), durable.clone(), events.clone())
                    .expect("real skill owner");
            node.load().await.expect("node startup");
            skills.load().await.expect("skills startup");
            (runtime, lifecycle, durable, events, node, skills)
        }
        pub async fn close(&self) {
            self.lifecycle.begin_shutdown();
            self.durable.stop().await;
            self.skills.close().await;
            self.runtime
                .close()
                .await
                .expect("close canonical database");
        }
        pub async fn restart(&mut self) {
            self.close().await;
            let mut config=ConfigModule::isolated(&self.directory.path().join(".happy")).expect("reload configuration");
            if let Some(worker)=&self.workflow_worker{config.set_workflow_test_executable(worker.clone());}
            self.config=Arc::new(config);
            (
                self.runtime,
                self.lifecycle,
                self.durable,
                self.events,
                self.node,
                self.skills,
            ) = Self::open(self.config.clone()).await;
        }
        pub fn runtime_file(&self) -> std::path::PathBuf {
            self.config.paths.directory.join("runtime.toml")
        }
        pub async fn wait_runtime(&self, field: &str, expected: &toml::Value) {
            let path = self.runtime_file();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
                        .and_then(|value| value.get(field).cloned())
                        .as_ref()
                        == Some(expected)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("observable runtime write");
        }
        pub fn install(&self, name: &str, contents: &str) -> std::path::PathBuf {
            let directory = self.config.global_skills_root().join(name);
            std::fs::create_dir_all(&directory).expect("skill directory");
            std::fs::write(directory.join("SKILL.md"), contents).expect("skill document");
            directory
        }
        pub async fn pending(&self) -> Result<Vec<serde_json::Value>> {
            self.runtime
                .transact(super::persistence::query_pending_calls)
                .await
        }
        pub async fn wait_pending_count(&self, function: &str, expected: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if self
                        .pending()
                        .await
                        .expect("pending procedure rows")
                        .iter()
                        .filter(|call| call["function"] == function)
                        .count()
                        == expected
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("observable procedure settlement");
        }
    }
}
