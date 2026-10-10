//! Execution scopes refuse unknown folders; catalog compute metadata may remain incomplete.
use super::{ProjectsModule, persistence};
use crate::product::{owners::RunnerUnavailableError, runtime::Context};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

impl ProjectsModule {
    pub fn location(&self, ctx: &Context<'_>, project: &Value) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        persistence::validate(&self.schemas, project)?;
        if let Some(owners) = &self.owners {
            let runners = &owners.runners;
            if project["kind"] == "home" && runners.enabled() {
                let runner = runners
                    .default_runner_id()
                    .ok_or_else(|| RunnerUnavailableError {
                        runner: String::new(),
                        name: "No default runner".to_owned(),
                    })?;
                let machine = runners.known_machine(ctx, &runner)?;
                let path = machine
                    .as_ref()
                    .and_then(|machine| machine["home"].as_str())
                    .ok_or_else(|| RunnerUnavailableError {
                        runner: runner.clone(),
                        name: runners.display_name(&runner),
                    })?;
                ensure!(
                    self.schemas
                        .valid("ownerProjectRepositoryRef", &json!(path))?,
                    "The runner's home folder is invalid."
                );
                return Ok(json!({"runnerId":runner,"path":path}));
            }
            if let Some(runner) = project["runnerId"].as_str() {
                if !runners.has(runner) {
                    return Err(RunnerUnavailableError {
                        runner: runner.to_owned(),
                        name: runners.display_name(runner),
                    }
                    .into());
                }
            } else if project["kind"] != "home" {
                runners.assert_local_execution()?;
            }
        }
        let mut location = json!({"path":project["repositoryRef"]});
        if let Some(runner) = project["runnerId"].as_str() {
            location["runnerId"] = json!(runner);
        }
        Ok(location)
    }
}
