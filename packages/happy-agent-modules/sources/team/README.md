# Team

Team owns organization authentication, installation-local users, and their profiles. It also
announces the human sender to the model without changing user messages or public history.

```text
Authenticated user message -> Base consumes message -> Team system notification -> user text
                                                   -> current sender in agent KV
                                                   -> last notice in history KV
```

`TeamModule` installs its own transactional notification hook. Each human-authored message
selects its durable sender ID; each inference refreshes that sender's name and email. Unchanged
profile text is not repeated. History replacement clears only the announcement, so the next
safe boundary restores the profile. A missing or unknown human identity clears the previous
profile. System and agent-generated messages never select a human, and standalone installations
do not announce team profiles.

`impl/teamSenderNotifications.ts` owns this bounded, transactional behavior. `persistence/` owns
user queries; profile changes continue through the existing identity-only public event surface.
