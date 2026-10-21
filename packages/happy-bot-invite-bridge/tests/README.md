# Gateway tests

`guestCredentials.test.ts` uses real private SQLite state to cover redemption recovery,
concurrent recipients, hashed credentials, session lifetime, cross-bot isolation, duplicate
delivery, read-only access, reporting, blocking, and send limits.

```text
guestCredentials.test.ts -> GuestStore -> temporary SQLite
```

The real daemon and HTTP/WebSocket pipeline are covered by
`packages/happy-agent-gym-tests/tests/app_clip_guests_exchange_only_their_own_messages_through_an_exported_bot.test.ts`.
Its optional live case uses a normally configured provider auth file without copying credentials.
