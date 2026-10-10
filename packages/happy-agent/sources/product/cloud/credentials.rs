//! Bounded ephemeral organization credentials; the rotating refresh token stays owner-only.
use super::*;

impl CloudModule {
    fn assert_credential(&self, id: &str, credential: &Arc<Credential>) -> Result<()> {
        self.running()?;
        if self.status()["status"] != "connected" {
            return Err(self.not_authenticated());
        }
        if credential.generation != self.generation.load(Ordering::Acquire)
            || !self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .any(|(key, value)| key == id && Arc::ptr_eq(value, credential))
        {
            return Err(self.error(
                409,
                "cloud_not_authenticated",
                "Cloud authentication has changed. Request a new team token.",
            ));
        }
        Ok(())
    }
    pub async fn mint_for_organization(
        self: &Arc<Self>,
        id: &str,
        cancel: CancellationToken,
    ) -> Result<String> {
        ensure!(!cancel.is_cancelled(), "The token request was cancelled.");
        self.running()?;
        if !self.schemas.valid("cloudOrganizationId", &json!(id))? {
            return Err(self.error(
                400,
                "invalid_request",
                "The team organization ID is invalid.",
            ));
        }
        if self.status()["status"] != "connected" {
            return Err(self.not_authenticated());
        }
        let waiter = Arc::new(cancel);
        let timestamp = now();
        let credential;
        let pending;
        let usable;
        {
            let mut cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            credential = if let Some(position) = cache.iter().position(|(key, _)| key == id) {
                cache.remove(position).expect("cache position").1
            } else {
                cache.retain(|(_, entry)| {
                    entry
                        .pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .is_some()
                        || entry
                            .token
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .as_ref()
                            .is_some_and(|token| token.expires_at > timestamp)
                });
                if cache.len() >= 100 {
                    let position = cache
                        .iter()
                        .position(|(_, entry)| {
                            entry
                                .pending
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .is_none()
                        })
                        .ok_or_else(|| self.unavailable("Cloud authentication is busy."))?;
                    cache.remove(position);
                }
                Arc::new(Credential {
                    token: Mutex::new(None),
                    pending: Mutex::new(None),
                    waiters: Mutex::new(Vec::new()),
                    refresh_after: AtomicU64::new(0),
                    generation: self.generation.load(Ordering::Acquire),
                })
            };
            cache.push_back((id.to_owned(), credential.clone()));
            usable = credential
                .token
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
                .filter(|token| token.issued_at <= timestamp && timestamp < token.expires_at);
            if usable.is_none() {
                let mut waiters = credential
                    .waiters
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                waiters.retain(|waiter| waiter.strong_count() > 0);
                ensure!(
                    waiters.len() < 128,
                    "Cloud authentication has too many waiting callers."
                );
                waiters.push(Arc::downgrade(&waiter));
            }
            let mut current = credential
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if current.is_none()
                && (usable.is_none()
                    || timestamp >= credential.refresh_after.load(Ordering::Acquire))
            {
                let entry = credential.clone();
                let id = id.to_owned();
                let background = usable.is_some();
                let module = self.clone();
                let receiver = self.launch(move |owner| {
                    Box::pin(async move {
                        let result = async {
                            let _lock = owner.credentials.lock().await;
                            owner.assert_credential(&id, &entry)?;
                            if !background
                                && !entry
                                    .waiters
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .iter()
                                    .any(|waiter| {
                                        waiter
                                            .upgrade()
                                            .is_some_and(|waiter| !waiter.is_cancelled())
                                    })
                            {
                                anyhow::bail!("The token request was cancelled.");
                            }
                            let (authentication, cloud) = owner.mint_in_lock(Some(&id)).await?;
                            owner.assert_credential(&id, &entry)?;
                            let boundary = Boundary::new(
                                &owner.config,
                                cloud["environment"]
                                    .as_str()
                                    .expect("connected environment"),
                            )?;
                            let token = validation::token(
                                &owner.schemas,
                                authentication["accessToken"]
                                    .as_str()
                                    .expect("validated token"),
                                &id,
                                authentication["user"]["id"]
                                    .as_str()
                                    .expect("verified user"),
                                &boundary.client_id,
                                false,
                            )
                            .map_err(|_| {
                                owner.unavailable("Cloud returned an invalid team access token.")
                            })?;
                            entry.refresh_after.store(
                                token.expires_at
                                    - 60_000.min((token.expires_at - token.issued_at) / 5),
                                Ordering::Release,
                            );
                            let value = json!(token.access_token);
                            *entry
                                .token
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token);
                            Ok(value)
                        }
                        .await;
                        if result.is_err() {
                            entry.refresh_after.store(now() + 5_000, Ordering::Release);
                        }
                        let mut cache = owner
                            .cache
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        *entry
                            .pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                        entry
                            .waiters
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clear();
                        if entry
                            .token
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .is_none()
                        {
                            cache.retain(|(key, value)| key != &id || !Arc::ptr_eq(value, &entry));
                        }
                        result
                    })
                })?;
                *current = Some(
                    async move {
                        match receiver.await {
                            Ok(Ok(value)) => {
                                Ok(value.as_str().expect("credential result").to_owned())
                            }
                            Ok(Err(error)) => Err(Arc::new(
                                error
                                    .downcast_ref::<CloudOperationError>()
                                    .cloned()
                                    .unwrap_or_else(|| CloudOperationError {
                                        status: 503,
                                        code: "cloud_unavailable",
                                        message: "Cloud authentication is temporarily unavailable."
                                            .into(),
                                        cloud: module.status(),
                                    }),
                            )),
                            Err(_) => Err(Arc::new(CloudOperationError {
                                status: 503,
                                code: "cloud_unavailable",
                                message: "Cloud authentication is temporarily unavailable.".into(),
                                cloud: module.status(),
                            })),
                        }
                    }
                    .boxed()
                    .shared(),
                );
            }
            pending = current.clone();
        }
        self.assert_credential(id, &credential)?;
        if let Some(token) = usable {
            return Ok(token.access_token);
        }
        let pending =
            pending.context("Cloud authentication did not schedule a credential refresh.")?;
        let token = tokio::select! {biased;_=waiter.cancelled()=>anyhow::bail!("The token request was cancelled."),result=pending=>result.map_err(|error|anyhow::Error::new((*error).clone()))?};
        self.assert_credential(id, &credential)?;
        Ok(token)
    }
    pub async fn mint_short_lived_for_organization(self: &Arc<Self>, id: &str) -> Result<Value> {
        if !self.schemas.valid("cloudOrganizationId", &json!(id))? {
            return Err(self.error(
                400,
                "invalid_request",
                "The team organization ID is invalid.",
            ));
        }
        let id = id.to_owned();
        self.workflow(move |module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                let (authentication, cloud) = module.mint_in_lock(Some(&id)).await?;
                let boundary = Boundary::new(
                    &module.config,
                    cloud["environment"]
                        .as_str()
                        .expect("connected environment"),
                )?;
                let token = validation::token(
                    &module.schemas,
                    authentication["accessToken"]
                        .as_str()
                        .expect("validated token"),
                    &id,
                    authentication["user"]["id"]
                        .as_str()
                        .expect("verified user"),
                    &boundary.client_id,
                    true,
                )?;
                let result = json!({"accessToken":token.access_token,"expiresAt":token.expires_at});
                ensure!(
                    module.schemas.valid("cloudShortLivedToken", &result)?,
                    "The short-lived access token is invalid."
                );
                Ok(result)
            })
        })
        .await
    }
}
