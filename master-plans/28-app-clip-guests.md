# Master plan 28: App Clip guest groups

Continue the App Clip experiment on another computer from
`experiment/app-clip-guests` in `slopus/happy-agent`. Keep it on that experiment
branch while completing the deployment work below. The native Preview app and
Clip live in their respective native repository; their continuation instructions
must travel with that repository.

## Current state

`a0fa2d668` added the scoped invitation gateway and exported-bot gym coverage.
`ae0a6eb46` added names and capacity-limited invitations. `c1d8a7878` made each
invitation one shared group chat. This branch also includes the preview edge and
these continuation instructions. No daemon API or frozen agent core changed.

The current choice, option A, uses one preapproved daemon guest and subtask per
invitation. Each person has a separate gateway member and credential. Everyone
joining the link sees the full history, including earlier messages. The gateway
computes sender labels and ownership, quotes member attribution as unverified
JSON, and keeps member names out of daemon instruction text. Revoking one member
retains their attribution and leaves the other members connected. Security review
approved this path; 18 gateway tests and both gym scenarios passed, including two
real-model replies. Two native clients joined through public HTTPS, shared history,
displayed each other's names, and restored their sessions after restart.

The live demo currently runs on the ephemeral Linux host `happy-core`: gateway
`127.0.0.1:8789`, an isolated gym daemon using the normal signed-in real model,
edge `127.0.0.1:8790`, and quick tunnel
`https://securities-feels-twin-texture.trycloudflare.com`. That hostname is pinned
in Preview 25. The five-seat link had two active test members and three free seats
after proof; redemption closes 24 hours after creation. Credentials and the live
link stay in private state, never this repository. Keep the running 8789 demo
alive while replacing it. The fixture script and state are ignored scratch files,
not a reproducible deployment or a portable source of credentials.

## Continue on another computer

Use Node 22.19 or newer and pnpm. Start from a fresh checkout:

```sh
git clone --branch experiment/app-clip-guests https://github.com/slopus/happy-agent.git
cd happy-agent
pnpm install --frozen-lockfile
pnpm --filter @slopus/happy-bot-invite-bridge test
pnpm --filter @slopus/happy-bot-invite-bridge check
pnpm --filter @slopus/happy-agent-gym-tests check
pnpm exec oxlint packages/happy-bot-invite-bridge/sources packages/happy-bot-invite-bridge/tests packages/happy-bot-invite-bridge/edge packages/happy-agent-gym-tests/tests/app_clip_members_share_one_group_and_isolate_other_invites.test.ts
pnpm --filter @slopus/happy-agent-modules build
pnpm --filter @slopus/happy-agent-compute build
pnpm --filter @slopus/happy-agent-gym-tests exec vitest run tests/app_clip_members_share_one_group_and_isolate_other_invites.test.ts
```

The online-model scenario is opt-in. Use the computer's normally configured Codex
auth file, without copying credentials into this repository:

```sh
HAPPY_CLIP_LIVE_AUTH_FILE=/absolute/path/to/codex-auth.json pnpm --filter @slopus/happy-agent-gym-tests exec vitest run tests/app_clip_members_share_one_group_and_isolate_other_invites.test.ts
```

If the checkout is too deep for Unix sockets, use a shorter checkout or the gym's
documented `HAPPY_AGENT_GYM_SCRATCH_DIRECTORY` setting. Run iOS/Android builds and
device checks on Kirill's Mac Mini, as required by the repository instructions.

## Deployment order

First, choose a stable HTTPS domain or named Cloudflare tunnel and configure the
same origin in the native build, associated domains, AASA, invitation links, and
Apple's App Clip experience. The current quick tunnel and Preview 25 pin do not
survive migration. A web card and AASA alone do not establish public App Clip
invocation. Done means a real phone opens the intended app/Clip from that stable
link and restores its session after restart.

Second, replace the gym fixture with a dedicated exported bot on the owner's
real daemon. Never export the Chief of Staff or reuse an export already connected
to another bridge. Use the existing owner tools to create the bot and export it
with service `App Clip`, `unknownSenders: ignore`, and a private token file. Create
an invitation with the desired capacity:

```sh
pnpm --filter @slopus/happy-bot-invite-bridge start invite /private/state BOT_ID 'Bot name' /private/invite.json https://YOUR_STABLE_HOST 5
```

Read the export's complete current allowlist, append only the printed shared
`groupUserId`, update it once, and verify it with the owner tools. Per-member seat
IDs do not belong on that allowlist. Then enable the invitation:

```sh
pnpm --filter @slopus/happy-bot-invite-bridge start mark-approved /private/state INVITATION_ID --group-user-id GROUP_USER_ID
```

Create `/private/registry.json` following the package README, with the bot ID,
export connect URL, private token-file path, and `trustedProxyAddress: 127.0.0.1`.
Run the gateway, edge, and tunnel in separate terminals or supervised services:

```sh
pnpm --filter @slopus/happy-bot-invite-bridge start serve /private/state /private/registry.json 8789
APPLE_TEAM_ID=466DQWDR8C APP_BUNDLE_ID=com.slopus.happy.preview CLIP_BUNDLE_ID=com.slopus.happy.preview.Clip APP_STORE_ID=6749025570 EDGE_PORT=8790 GATEWAY_PORT=8789 node packages/happy-bot-invite-bridge/edge/edge.mjs
cloudflared tunnel --url http://127.0.0.1:8790
```

The last command creates a temporary quick tunnel. Replace it with the chosen
stable named tunnel for deployment. This edge trusts Cloudflare's client-IP
header from its loopback tunnel; do not put a different untrusted proxy in front
of it. It forwards only guest routes, never the owner API or daemon socket.
Operational commands are local owner actions:

```sh
pnpm --filter @slopus/happy-bot-invite-bridge start members /private/state INVITATION_ID
pnpm --filter @slopus/happy-bot-invite-bridge start reports /private/state
pnpm --filter @slopus/happy-bot-invite-bridge start revoke-member /private/state INVITATION_ID MEMBER_ID
pnpm --filter @slopus/happy-bot-invite-bridge start revoke /private/state INVITATION_ID
```

Done means two real devices share a conversation through the real owner's
export, recover sessions, preserve names, and enforce capacity, revocation,
read-only mode, reports, isolation, and rate limits.

Third, pursue option B if real per-member Team guests must share one daemon
conversation. The existing exported-bot protocol is direct-only. This requires
explicit human authorization for the specific `API.md` contract change before
implementation, followed by the repository's specification/client-release flow.
Do not emulate it by silently extending the protocol. Separately harden existing
one-to-one daemon guest instructions: render names as quoted, unverified data and
keep them out of permission-reviewer context. The current App Clip path avoids
that name surface with its fixed group label; other guest paths still need review.

Finally, design the Happy-run multi-tenant broker, moderation/report operations,
and push notifications. A broker forwarding this guest chat sees plaintext and
holds export credentials; it is not the blind encrypted relay. Tenant isolation,
credential ownership, retention, quotas, and the operator's plaintext access must
be explicit. Reports already persist per-member metadata but need an operator
workflow and response policy. Push notifications need their own delivery and
privacy design beyond the current foreground long-polling chat. These are next
actions, not claims that the experiment already implements them.
