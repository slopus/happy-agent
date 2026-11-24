# Push

Which phones a person can be notified on, and delivery to them through Happy's push relay. Happy
Cloud already let a phone register for notifications; this module gives a self-hosted or team
server the same thing, behind the same routes, so the mobile apps use one implementation.

It depends on the team module, to find the authenticated member, on the config module, for this
installation's `instanceId`, and on Durable Functions, to carry a notification from the caller's
commit to the relay. It has no tools: nothing here decides that a person should be notified.

```text
phone ── native token ──> Happy's relay ── HappyPushToken[...] ──> phone
phone ── PUT /v0/cloud/push/registrations/:id ──> API ──> register()      (stores the token)

caller ── send(ctx, recipient, notification) ──> durable call, committed with the caller
                                                      │ after commit, one person at a time
                                                      v
                              settings on? ── live registrations ── POST to the relay, once each
                                                      │
                              DeviceNotRegistered ──> that registration is removed
```

## Owners

Registration and settings take their owner from the caller's context; no caller names one. In team
mode the owner is the member's installation-local Happy user ID, and a context without a member
throws `TeamAuthenticationError`. Standalone, the owner is `standalone`, the installation's one
person. `send` is the exception: its caller names the recipient, because it runs for an agent
rather than for a signed-in person.

## The token

`HappyPushToken[<22 letters and digits>]` is a capability: whoever holds the text can send to that
phone. Inside the module it is a `PushToken`, whose text sits in a private field. Interpolating,
serializing, or logging one prints `HappyPushToken[redacted]`; only `expose()` returns the text,
and only the stored row and the relay request call it. No operation returns a token, no error
message repeats one, and log lines carry IDs and outcomes only.

The token is stored as it is, in the daemon's owner-only database, like the secrets catalog. The
daemon has no sealing facility, so anyone who can read the database can already act as the daemon.

## Public operations

- `register(ctx, id, request)` registers the caller's phone under `id`, a lowercase UUID the phone
  keeps for this server, or renews it. `request` is what the phone sent, unchecked: `{ token,
platform, appId, locale? }`. It returns `{ id, version, expiresAt }`, with a new UUID `version`
  every time and `expiresAt` 30 days ahead.
- `unregister(ctx, id, version)` removes the caller's registration at exactly that version. One
  that is gone, someone else's, or renewed since is left alone, and the call still succeeds.
- `settings(ctx)` and `saveSettings(ctx, settings)` read and replace `{ enabled }`, which is `true`
  until the person turns it off.
- `send(ctx, recipient, notification)` notifies one person on their phones. See Delivery.

A refused operation throws `PushError` with `invalid_request` for a malformed ID, body, or version,
`not_found` for an `id` that belongs to someone else, and `registrations_full` for a new phone past
the limit. Its message is safe to show.

## Registration rules

One transaction applies them in this order, matching Happy Cloud:

1. The caller's expired registrations are removed, so they never count toward the limit.
2. An `id` another person holds is refused as `not_found`.
3. The same token under another of the caller's IDs is removed. A reinstalled app registers under
   a new ID, and one phone must not receive each notification twice.
4. A new `id` when the caller already holds 20 is refused. Renewing one of the 20 is accepted.
5. The registration is stored for another 30 days under a newly minted version.

Two people may register the same phone; each holds their own registration of it.

## Delivery

`send` writes one durable call in the caller's transaction and returns. Nothing reaches the relay
if that transaction rolls back, and a committed notification survives a restart. Calls for one
person run one at a time in the order they were sent, so a later notification with the same
`collapseId` reaches the relay after the one it replaces. Nobody is told what became of a
notification, by design: the agent that asked is never to learn whether or where it was shown.

When the call runs, the module reads the person's settings and unexpired registrations as they are
then. A person who turned notifications off, or has no live phone, gets nothing. Otherwise each
phone gets one `POST https://push.cluster-fluster.com/v1/push/send` with this body:

```json
{
    "to": "HappyPushToken[...]",
    "title": "iOS preview 24 uploaded; prod is blocked",
    "body": "Prod needs build number 164 committed on main first",
    "data": {
        "kind": "happy.cloud.push.v1",
        "instanceId": "k3x9q2m7p0a4b8c1d5e6f7g2",
        "userId": "tz4a98xxat96iws9zmbrgj3a",
        "agentId": "pfh0haxfpzowht3oi213cqos",
        "notificationId": "0197f0c2-7d1e-7c3a-b0a5-2a4b6c8d0e1f"
    },
    "collapseId": "k3x9q2m7_pfh0haxf",
    "sound": "default",
    "channelId": "messages",
    "ttl": 300
}
```

`data` has exactly those five strings, because the Android app refuses any other set of keys.
`userId` is the recipient: a team user ID, or `standalone`. `collapseId` is present only when the
notification has one, because the relay refuses a field it does not know.

Each request is one attempt: no redirect is followed, the whole exchange has eight seconds, at most
16 KiB of the answer is read, and the request needs no credentials because the token is the
capability. The answer becomes one outcome:

| Outcome        | When                                                                                    | What happens                  |
| -------------- | --------------------------------------------------------------------------------------- | ----------------------------- |
| `accepted`     | The relay returned one `ok` ticket with an ID.                                          | Nothing more.                 |
| `unregistered` | The relay returned `DeviceNotRegistered`.                                               | That registration is removed. |
| `rejected`     | A redirect, a refused request, or a ticket naming credentials, size, or sender.         | Nothing more.                 |
| `unknown`      | A timeout, a transport or server failure, a rate limit, or an answer that is not clear. | Nothing more.                 |

Nothing is retried. An `unknown` request may have been delivered, so sending it again could show
the person the same thing twice. A phone is marked in the call's own state before its request, so
a restart in the middle of a notification carries on with the phones not yet tried and never sends
any phone a second request. Each outcome is logged as one `push:delivery` line.

## Storage

Migration `001-push` creates two tables. `happy_agent_push_registrations` holds one row per
registration: its ID, owner, version, token, platform, app, locale, and expiry, with the owner and
token unique together. `happy_agent_push_settings` holds a row only for a person who has chosen.
