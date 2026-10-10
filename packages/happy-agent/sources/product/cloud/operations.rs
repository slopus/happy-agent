//! Organization mutations use one serialized, verified credential and never replay HTTP.
use super::*;

impl CloudModule {
    async fn organization_work(
        self: &Arc<Self>,
        work: impl FnOnce(Arc<Self>, Boundary, String) -> BoxFuture<'static, Result<Value>>
        + Send
        + 'static,
    ) -> Result<Value> {
        self.organization_work_with_mutation(None, work).await
    }
    async fn organization_work_with_mutation(
        self: &Arc<Self>,
        mutation: Option<Value>,
        work: impl FnOnce(Arc<Self>, Boundary, String) -> BoxFuture<'static, Result<Value>>
        + Send
        + 'static,
    ) -> Result<Value> {
        self.workflow(move |module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                let (authentication, cloud) =
                    module.mint_in_lock_with_mutation(None, mutation).await?;
                let boundary = Boundary::new(
                    &module.config,
                    cloud["environment"]
                        .as_str()
                        .expect("connected environment"),
                )?;
                work(
                    module.clone(),
                    boundary,
                    authentication["accessToken"]
                        .as_str()
                        .expect("validated token")
                        .to_owned(),
                )
                .await
            })
        })
        .await
    }
    fn organization_id(&self, id: &str) -> Result<()> {
        if !self.schemas.valid("cloudOrganizationId", &json!(id))? {
            return Err(self.error(
                400,
                "invalid_request",
                "The Cloud organization ID is invalid.",
            ));
        }
        Ok(())
    }
    pub async fn list_organizations(self: &Arc<Self>) -> Result<Value> {
        self.list_organizations_with_mutation(None).await
    }
    pub async fn list_organizations_with_mutation(
        self: &Arc<Self>,
        mutation: Option<Value>,
    ) -> Result<Value> {
        self.organization_work_with_mutation(mutation, |module, boundary, token| {
            Box::pin(async move {
                let organizations = boundary.organizations(&token, false).await.map_err(|_| {
                    module.unavailable("Cloud organizations are temporarily unavailable.")
                })?;
                Ok(json!({"organizations":organizations}))
            })
        })
        .await
    }
    pub async fn list_teams(self: &Arc<Self>) -> Result<Value> {
        self.organization_work(|module, boundary, token| {
            Box::pin(async move {
                boundary
                    .organizations(&token, true)
                    .await
                    .map_err(|_| module.unavailable("Happy teams are temporarily unavailable."))
            })
        })
        .await
    }
    pub async fn create_organization(self: &Arc<Self>, name: &str) -> Result<Value> {
        self.create_organization_with_mutation(name, None).await
    }
    pub async fn create_organization_with_mutation(
        self: &Arc<Self>,
        name: &str,
        mutation: Option<Value>,
    ) -> Result<Value> {
        if !self.schemas.valid("cloudOrganizationName", &json!(name))? {
            return Err(self.error(
                400,
                "invalid_request",
                "The Cloud organization name is invalid.",
            ));
        }
        let name = name.to_owned();
        self.organization_work_with_mutation(mutation, move |module, boundary, token| {
            Box::pin(async move {
                boundary
                    .create_organization(&token, &name, false)
                    .await
                    .map_err(|error| match error {
                        RemoteError::InvalidOrganization => module.error(
                            400,
                            "invalid_request",
                            "The Cloud organization name is invalid.",
                        ),
                        _ => module.unavailable("Cloud organizations are temporarily unavailable."),
                    })
            })
        })
        .await
    }
    pub async fn delete_organization(self: &Arc<Self>, id: &str) -> Result<()> {
        self.delete_organization_with_mutation(id, None).await
    }
    pub async fn delete_organization_with_mutation(
        self: &Arc<Self>,
        id: &str,
        mutation: Option<Value>,
    ) -> Result<()> {
        self.organization_id(id)?;
        let id = id.to_owned();
        self.organization_work_with_mutation(mutation, move |module, boundary, token| {
            Box::pin(async move {
                boundary
                    .delete_organization(&token, &id)
                    .await
                    .map_err(|error| match error {
                        RemoteError::InvalidOrganization => module.error(
                            400,
                            "invalid_request",
                            "The Cloud organization ID is invalid.",
                        ),
                        RemoteError::Forbidden => module.error(
                            403,
                            "forbidden",
                            "You do not have permission to delete this Cloud organization.",
                        ),
                        _ => module.unavailable("Cloud organizations are temporarily unavailable."),
                    })?;
                Ok(Value::Null)
            })
        })
        .await?;
        Ok(())
    }
    pub async fn get_workos_state(self: &Arc<Self>) -> Result<Value> {
        self.workflow(|module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                let (authentication, cloud) = module.mint_in_lock(None).await?;
                let boundary = Boundary::new(&module.config, cloud["environment"].as_str().expect("connected environment"))?;
                Ok(json!({"workosClientId":boundary.client_id,"workosUserId":authentication["user"]["id"]}))
            })
        }).await
    }
    pub async fn create_team(self: &Arc<Self>, name: &str, endpoint: &str) -> Result<Value> {
        if !self.schemas.valid("cloudOrganizationName", &json!(name))? {
            return Err(self.error(400, "invalid_request", "The Happy team name is invalid."));
        }
        let endpoint = validation::endpoint(&self.schemas, endpoint).ok_or_else(|| {
            self.error(
                400,
                "invalid_request",
                "The Happy team endpoint is invalid.",
            )
        })?;
        let name = name.to_owned();
        self.organization_work(move |module, boundary, token| {
            Box::pin(async move {
                let mut created = boundary.create_organization(&token, &name, true).await.map_err(|error| match error {
                    RemoteError::InvalidOrganization => module.error(400, "invalid_request", "The Happy team name is invalid."),
                    _ => module.unavailable("Happy teams are temporarily unavailable."),
                })?;
                let id = created["id"].as_str().expect("validated organization");
                match boundary.endpoint(&token, id, &endpoint).await {
                    Ok(endpoint) => {
                        created["endpoint"] = json!(endpoint);
                        Ok(created)
                    }
                    Err(error) => {
                        let message = format!("Happy team {id} was created, but its endpoint could not be configured. Use update_happy_team with this team ID to finish setup.");
                        Err(if matches!(error, RemoteError::Forbidden) {
                            module.error(403, "forbidden", message)
                        } else {
                            module.error(503, "cloud_unavailable", message)
                        })
                    }
                }
            })
        }).await
    }
    pub async fn set_team_endpoint(self: &Arc<Self>, id: &str, endpoint: &str) -> Result<String> {
        self.organization_id(id)?;
        let endpoint = validation::endpoint(&self.schemas, endpoint).ok_or_else(|| {
            self.error(
                400,
                "invalid_request",
                "The Happy team endpoint is invalid.",
            )
        })?;
        let id = id.to_owned();
        let result = self.organization_work(move |module, boundary, token| {
            Box::pin(async move {
                boundary.endpoint(&token, &id, &endpoint).await.map(Value::String).map_err(|error| match error {
                    RemoteError::InvalidEndpoint => module.error(400, "invalid_request", "The Happy team endpoint is invalid."),
                    RemoteError::Forbidden => module.error(403, "forbidden", "The connected Cloud user is not an administrator of this Happy team."),
                    _ => module.unavailable("Happy teams are temporarily unavailable."),
                })
            })
        }).await?;
        Ok(result.as_str().expect("endpoint result").to_owned())
    }
    pub async fn invite_team_member(self: &Arc<Self>, id: &str, email: &str) -> Result<Value> {
        let email = validation::email(&self.schemas, email)
            .filter(|_| {
                self.schemas
                    .valid("cloudInvitationOrganization", &json!(id))
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                self.error(
                    400,
                    "invalid_request",
                    "The team ID or invitation email is invalid.",
                )
            })?;
        let id = id.to_owned();
        self.organization_work(move |module, boundary, token| {
            Box::pin(async move {
                boundary.invite(&token, &id, &email).await.map_err(|error| match error {
                    RemoteError::InvalidOrganization => module.error(400, "invalid_request", "The team ID or invitation email is invalid."),
                    RemoteError::Forbidden => module.error(403, "forbidden", "The connected Cloud user must administer this Happy team to invite members."),
                    RemoteError::InvitationConflict(reason) => module.error(409, "conflict", if reason == "already_member" {
                        "This email address already belongs to the Happy team."
                    } else {
                        "This email address already has a pending invitation to the Happy team."
                    }),
                    _ => module.unavailable("The invitation could not be confirmed. It may already have been sent; check the team's invitations before trying again."),
                })
            })
        }).await
    }
}
