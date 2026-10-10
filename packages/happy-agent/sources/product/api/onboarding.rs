//! The existing readiness resource combines installation and profile state.
use super::*;

impl ApiModule {
    pub(super) async fn onboarding_state(&self) -> anyhow::Result<Value> {
        let profile = self.profile.clone();
        let projects = self.projects.clone();
        let (profile_done, project_done) = self
            .runtime
            .transact(move |ctx| {
                let profile_done = profile
                    .get(ctx)?
                    .is_some_and(|profile| !profile["name"].is_null());
                Ok((profile_done, projects.has_active_project(ctx)?))
            })
            .await?;
        let marker = self.config.onboarding_completed().await?;
        let signed_in = self.config.onboarding_providers()?;
        let state = json!({
            "completed": marker && (!self.config.team_enabled() || profile_done),
            "steps": {
                "profile": {"done": profile_done},
                "project": {"done": project_done},
                "providers": {"done": !signed_in.is_empty(), "signedIn": signed_in},
            },
        });
        anyhow::ensure!(
            self.schemas.valid("ownerOnboardingState", &state)?,
            "The onboarding state is invalid."
        );
        Ok(state)
    }

    pub(super) async fn complete_onboarding(&self) -> anyhow::Result<Value> {
        self.config.complete_onboarding().await?;
        let state = json!({"completed": true});
        anyhow::ensure!(
            self.schemas.valid("ownerOnboardingCompleted", &state)?,
            "The onboarding completion is invalid."
        );
        Ok(state)
    }
}
