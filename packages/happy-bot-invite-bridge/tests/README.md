# Gateway tests

`guestCredentials.test.ts` uses real private SQLite state to cover redemption recovery,
concurrent recipients, hashed credentials, session lifetime, cross-bot isolation, duplicate
delivery, read-only access, reporting, blocking, and send limits.

`multiSeatInvites.test.ts` covers concurrent and cross-process seat claims, recovery when full,
shared history including late joiners, one-member revocation without seat reuse, forged sender
text, group isolation and limits, and rejected or normalized display names.
`transportFailures.test.ts` verifies the fixed group label and quoted attribution reach the
bridge frame, plus IPv6 proxy addresses, HTTP failure isolation, durable failures, replay, and backpressure.

```text
guestCredentials.test.ts -> GuestStore -> temporary SQLite
```

The real daemon and HTTP/WebSocket pipeline are covered by
`packages/happy-agent-gym-tests/tests/app_clip_members_share_one_group_and_isolate_other_invites.test.ts`.
Its optional live case uses a normally configured provider auth file without copying credentials.
