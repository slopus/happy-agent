# App Clip invitation bridge

This private executable gives an App Clip a narrow text chat API. It is a chat-service bridge
for the existing exported-bot protocol, not a Happy Agent API or a new agent runtime. The daemon
continues to enforce its allowlist, run one guest subtask per invitation in Auto, and persist
outgoing replies. Each invitation is one group chat. The gateway owns individual member
identities and credentials; all its members share the same daemon guest. No custom daemon build is needed.

```text
App Clip -- HTTPS /v1 --> invitation bridge -- exported-bot WebSocket --> daemon
                             |                                      |
                      private guest SQLite                 guest / isolated subtask
```

The bridge must run as a trusted process beside the standalone daemon, or reach an exported-bot
WebSocket over WSS. A bridge token grants access to every guest of its export. Use a **dedicated
bridge export**, never an export already connected to another program: a second connection
replaces the first. Telegram exports can coexist.

## Local setup

All paths below are absolute. Keep state, token files, registry, and invitation output outside
version control. The CLI writes state directories with mode 0700 and invitations with mode 0600;
it never prints invitation or bridge credentials. The registry contains file paths, not tokens.

1. Create a dedicated bot with a restricted folder and purpose using the existing owner tools.
   Never export the Chief of Staff. Export it with `set_bridge_exported_bot`, `service: "App Clip"`,
   `unknownSenders: "ignore"`, and a private `tokenFile`.
2. Create an invitation:

    ```sh
    pnpm --filter @slopus/happy-bot-invite-bridge start invite /private/state BOT_ID 'Bot name' /private/invite.json https://app.happy.engineering 2
    ```

    Choose 1–20 members. The private file contains the opaque invitation URL, invitation ID,
    `maxMembers`, and the single pre-generated bridge `groupUserId`. The CLI also prints this ID.
    The URL contains no capacity, bot, or guest identifiers. The link can be redeemed
    for 24 hours. Each new person enters their name and claims a distinct member seat and
    private session credential. Everyone joining the link sees the entire shared chat, including
    messages sent before joining. Anyone holding this shareable link can take a seat until all N are gone;
    treat it as an invitation to N otherwise unknown people. Keep the existing optional
    `read-only` last argument only when deliberately creating that kind of session.

3. **Before sharing**, owner authorization must allow the shared group bridge ID. Call
   `get_exported_bot_status`, read the full current `allowedUsers`, append the generated `groupUserId`,
   then call `set_bridge_exported_bot` once with that complete list. The daemon allowlist has
   a hard limit of 256 IDs (`MAX_EXPORTED_BOT_ALLOWED_USERS`); check that the addition fits.
   Re-read `get_exported_bot_status` and verify that ID before enabling the invitation.
   Serialize these owner operations;
   the replace-list tool has no compare-and-swap and concurrent editors can overwrite additions.
   The public gateway has no owner credential or enrollment capability. If approval is omitted,
   the gateway refuses redemption with 503. After the allowlist update succeeds, enable the link:

    ```sh
    pnpm --filter @slopus/happy-bot-invite-bridge start mark-approved /private/state INVITATION_ID --group-user-id GROUP_USER_ID
    ```

    Run this owner-only local step only after verifying the group ID on the export's allowlist.
    The supplied ID must match the invitation's one shared bridge identity. Per-member gateway
    seat IDs are never sent to the daemon and must not be added to its allowlist. The group ID remains on the
    allowlist until the owner prunes it; only this trusted gateway holds the credential that can use it.
    Removing it later from the daemon allowlist should be paired with gateway revocation; the
    gateway cannot inspect the daemon's owner-only configuration. An `ask` export may return the
    daemon's fixed access-request notice if the owner makes these settings inconsistent.

4. Create a private registry:

    ```json
    {
        "trustedProxyAddress": "127.0.0.1",
        "exports": [
            {
                "botId": "BOT_ID",
                "connectUrl": "ws+unix:///absolute/daemon.sock:/v0/exported-bots/connect?protocol=1",
                "tokenFile": "/private/clip-bridge.token"
            }
        ]
    }
    ```

    Up to ten distinct exports can share one endpoint. Each has its own WebSocket and server-side
    credential. Invitations select the bot; the Clip has no compiled bot identifier. Adding
    another bot changes this private registry and restarts the bridge, with no Clip rebuild.
    `trustedProxyAddress` is optional: set it only when that exact TCP peer is the proxy you own.
    It must replace `X-Forwarded-For` with exactly one validated client IP, without a forwarded chain.
    Without this option, forwarded-address headers are ignored.

5. Start:

    ```sh
    pnpm --filter @slopus/happy-bot-invite-bridge start serve /private/state /private/registry.json 8787
    ```

The listener binds only `127.0.0.1`. A local simulator demo can use a secure tunnel to this port.
**No public host is deployed by this package.** Production must explicitly deploy an HTTPS proxy
on the Clip's trusted origin, forward only `/v1/bot-invites/redeem` and `/v1/bot-guest/*` here, serve
the associated-domain/AASA and invitation pages, and apply client-IP rate limits at the proxy.
Do not expose the daemon socket, owner API, or registry through that proxy.

## Preview HTTPS edge

The included `edge/edge.mjs` serves AASA, the invitation landing page, and only the guest API
routes. Set the Apple IDs to match the installed app and its Clip. For Happy Preview:

```sh
APPLE_TEAM_ID=466DQWDR8C APP_BUNDLE_ID=com.slopus.happy.preview \
CLIP_BUNDLE_ID=com.slopus.happy.preview.Clip APP_STORE_ID=6749025570 \
EDGE_PORT=8790 GATEWAY_PORT=8789 node packages/happy-bot-invite-bridge/edge/edge.mjs
```

In another terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8790
```

Use the resulting HTTPS origin when creating an invitation. Set the gateway registry's
`trustedProxyAddress` to `127.0.0.1`. The edge drops incoming `X-Forwarded-For` and replaces it with
Cloudflare's `CF-Connecting-IP`; both IPv4 and IPv6 are accepted by the gateway. Run it only behind
the Cloudflare tunnel: the loopback listener trusts that tunnel's header. Do not expose it through
another proxy without revisiting that trust boundary. Nothing logs invitation URLs or credentials.
The edge aborts an upstream long poll when the client disconnects.

A quick tunnel changes hostname on restart. It is suitable for a temporary preview; a stable
domain or named tunnel and matching native associated-domain/host configuration are needed for
continuity. AASA and the web card alone do not register an App Clip experience with Apple. The
current Preview 25 host is pinned in the native build; changing it requires a new build. See
[the continuation plan](../../master-plans/28-app-clip-guests.md).

## Client contract

`POST /v1/bot-invites/redeem` accepts `{token, redeemNonce, displayName}`. Token and nonce are base64url strings of
43 characters representing independent 32-byte random values. The client persists its nonce
before sending the request. A successful response is
`{sessionId, sessionToken, memberId, displayName, botName, expiresAt, readOnly}`; `expiresAt` is Unix milliseconds.
The session lasts 30 days from first redemption unless the owner revokes it or the guest leaves.
Its expiry does not extend on retry. This is independent of the invitation's 24-hour redeem window.

A retry with the same token and nonce recovers the same session ID and rotates the session bearer,
invalidating the previous bearer. Recovery keeps the original display name, consumes no seat,
and works even when the pool is full. Another nonce atomically claims the next unused seat;
an exhausted pool returns 410 `{code:"invite_full",error:"This invite is full."}` without counts,
names, or member IDs. Never concurrently recover the same member nonce.
Persist the returned session bearer in the keychain before discarding the pending nonce. There is
no periodic bearer refresh: the session remains valid through its stated expiry, with owner revoke
available throughout. A lost keychain requires a new owner invitation.

Names are self-asserted and unverified: someone can call themselves "Kirill". They never select
routing, credentials, keys, or paths. The server normalizes NFC, rejects Unicode control,
format, private-use, unassigned, surrogate, line, and paragraph separator characters, collapses
ordinary whitespace and trims. Names must contain 1–40 grapheme clusters of letters, marks,
numbers, spaces, `.`, `'`, `’`, `-`, or `_`, with no leading combining mark and at most four
marks per grapheme. A rejected name returns 400 `code:"invalid_name"` before any seat is claimed;
the client can correct it and resubmit the same nonce. The first accepted name is immutable.

The bridge frame's `name` is always the fixed owner-controlled label `App Clip group`; member
names never enter the daemon's instruction wrapper. Every user message is encoded as an
explicitly untrusted JSON envelope containing a server-assigned `sender.memberId`, the immutable
`sender.displayName`, `sender.verified: false`, and the quoted `text`. Newlines, quotes, and Unicode
line separators inside the text cannot change the outer sender. The daemon creates one
`Team` guest and one `App Clip group on App Clip` subtask for that invitation. Individual members
are gateway identities, not separate daemon Team guests. Messages retain guest origin and Auto
permissions. The preapproved group does not trigger stranger-access notices to the Chief of Staff.
The random internal `memberId` is visible to the owner's bot in that envelope. Other guests
receive the display name and their own `isMine` flag; message history does not expose member IDs.

All session routes require `Authorization: Bearer <sessionToken>`. Each request checks the bound
session, bot, expiry, revocation, and block state. The bearer opens only these routes, not the
daemon API. Credentials and invitation tokens are stored only as SHA-256 hashes in SQLite.

- `GET /v1/bot-guest/sessions/:id/messages?after=<cursor>&wait=25` returns
  `{messages:[{id,role,text,createdAt,senderName,isMine}],cursor,status}`. Roles are `user` and `assistant`, times are
  Unix milliseconds, cursor is a nullable numeric string, and status is `online` or `offline`.
  `after` defaults to zero; pages contain at most 100 messages. `wait` defaults to zero and is at
  most 25 seconds. One long poll per session is allowed. Revoke/expiry is checked at least once
  per second while waiting and on the final read.
  Every member sees the invitation's full history. The server derives `senderName` and `isMine`
  from the authenticated member and stored author; a client cannot set either. Assistant messages
  use the bot's name and `isMine: false`. Revoked members' past messages retain their names.
- `POST` to that messages route accepts `{localId,text}` and returns 202 `{}` after durable
  queuing. `localId` is 1–128 ASCII letters, digits, `_` or `-`; text is 1–4,000 characters and
  must contain non-whitespace. Retrying the same ID and text is safe. Reusing it for different
  text receives 409. Sends remain queued while the bot is offline. A daemon terminal rejection
  is not retried and produces a fixed delivery-failed notice. An accepted send does not promise
  that inference will succeed.
- `POST /v1/bot-guest/sessions/:id/report` with `{}` records the timestamp, invitation and member IDs
  for owner inspection. It does not send report content to inference.
- `POST /v1/bot-guest/sessions/:id/block` with `{}` ends access immediately. The client should
  clear its keychain session and leave the conversation after success.

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| 400    | Invalid JSON, input, cursor, or wait duration                                              |
| 401    | Missing or malformed bearer                                                                |
| 403    | Read-only session cannot send                                                              |
| 404    | Unknown, revoked, blocked, wrong-session, or rotated credential                            |
| 409    | Local message ID reused with different text                                                |
| 410    | `invite_full` for exhausted seats; `expired` for an expired invite or session              |
| 413    | Request body exceeds 16 KiB                                                                |
| 429    | Rate or transcript limit; `Retry-After: 60`. Poll conflict uses `Retry-After: 1`           |
| 503    | Bot offline during redemption, unavailable export, or bounded queue full; `Retry-After: 1` |

## Durability, limits, and trust

The gateway stores its own guest-only transcript in private SQLite. It never queries owner
history or a daemon database. Outgoing message IDs are random and persisted before their first
bridge send; reconnects reuse them. Replies are committed before the daemon receives their ack;
their bot/guest/sequence identity prevents duplicate history after a crash. Attachments are not
served: attachment fields and paths are discarded, and attachment-only replies become a fixed
notice that files are unavailable here. The daemon's stranger notice is fixed service text and
does not contain another person's history.

Oversized reply text is shortened to 32,000 characters with a visible marker, then acknowledged
after its durable write. A rejected send becomes a fixed assistant notice without daemon details.
Unexpected HTTP failures return fixed 500 responses and do not stop unrelated conversations.
An export with a refused credential remains offline while other exports continue serving.

This bridge terminates TLS and stores guest plaintext. It is a trusted chat endpoint, **not an
end-to-end encrypted client of Happy's relay**. Deploy beside the owner daemon when possible.
Its credentials and storage need the same protection as that daemon. This does not make an
otherwise blind Happy relay a plaintext processor.

There are at most 100 pre-generated seats across all invitations, including unclaimed or revoked
seats. Each member has at most 100 user messages. Each group has at most 500 user messages and
1,000 total messages, leaving space for replies. New invitation creation
prunes invitations that expired over 31 days ago, after every possible 30-day member session ended.
Existing transcripts and deduplication IDs remain until that expiry; cursors increase monotonically.
Per member, at most ten sends per minute are accepted, with thirty across the group. The listener admits at most 200 concurrent
requests/connections and 100 long polls; the SQLite work queue admits 256 operations and the
bridge uses a one-message stream buffer with socket backpressure and bounds unacknowledged
outgoing messages at 32 per export. Reconnects replay durable unacknowledged work.

The HTTP limit is 120 requests and ten redemption attempts per minute per **TCP peer**, or per
client IP when the exact proxy hop is explicitly configured. Authenticated session requests
have separate session buckets, so failed public redemptions cannot consume their request budget.
The proxy must still enforce ingress limits. No request paths, headers, bodies, or
credentials are logged. Configure proxy access/error logging to redact `/bot/invite/*`, request
bodies, and Authorization headers; do not log credential-bearing invocation URLs.
Each invitation also bounds new claims per minute to its N-seat capacity; recovery claims no seat.

429 responses include `code: "poll_conflict"` for an existing long poll and `code: "limit_reached"`
for the permanent transcript cap; the latter requires a new owner invitation. Other rate limits
are temporary. The numeric cursor currently comes from one private database sequence, so gaps
can reveal approximate cross-session message volume, never their contents or identities.
After the 1,000-message retention cap, further incoming replies are acknowledged and discarded;
existing history stays intact. The owner should issue a new invitation before that cap is reached.

Owner commands, using the same private state directory:

```sh
pnpm --filter @slopus/happy-bot-invite-bridge start reports /private/state
pnpm --filter @slopus/happy-bot-invite-bridge start members /private/state INVITATION_ID
pnpm --filter @slopus/happy-bot-invite-bridge start revoke-member /private/state INVITATION_ID MEMBER_ID
pnpm --filter @slopus/happy-bot-invite-bridge start revoke /private/state INVITATION_ID
```

`members` lists names, member IDs, gateway seat IDs, joined and last-active times, revoked state, and
seats used/max. These are local owner operations; no guest HTTP endpoint exposes the roster.
Member revocation or leaving kills only that member. Invitation revocation kills every member.
Neither revocation, expiry, nor leaving returns a seat to the pool. History remains visible to
other members, with its original attribution. Issue a new invitation for a new group instead.
Revocation prevents future reads, sends, recovery, and queued delivery. It cannot undo a message
the daemon already accepted or cancel an already-running guest task. The owner can also remove
the shared group from the existing daemon allowlist and archive its subtask, ending the group.
Revoking one gateway member never removes that shared guest or disrupts the other members. The gateway supplies
report and leave controls; content moderation policy, operator response, and App Store metadata
remain explicit distribution work.

This undeployed preview advances private storage to generation 3 (`guests-v3.sqlite`). Earlier
invitations and sessions are not carried over, repaired, or reinterpreted. Issue fresh links on
upgrade. Already-running earlier demos can continue against their separate old files.
