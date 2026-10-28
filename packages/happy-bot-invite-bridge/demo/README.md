# Isolated preview demo

Two dev scripts that ran the public App Clip preview on a Mac without touching the owner's
daemon. They are a demo, not a deployment: everything stops when the processes or the computer
stop, and a quick-tunnel host changes on restart.

- `isolatedDaemon.ts` starts a throwaway gym installation with live Codex inference from the
  computer's normally configured auth file, read in place. It creates one dedicated bot,
  `Happy`, primes it to chat only, and answers every Auto review with a denial so guests cannot
  drive tools. It writes `bot.json`, then exports the bot as `App Clip` with
  `unknownSenders: ignore` to every group ID listed in `allowed.json`, re-exporting whenever that
  file changes, and writes the gateway `registry.json`.
- `verifyInvite.mjs` redeems an invitation file through its public origin, sends a marker
  message, long-polls for the reply, and prints no credentials. Use a separate one-seat
  invitation so the shared link's seats and history stay clean.

Keep the demo directory private and ignored, such as `.context/clip-demo`. It receives the
invitation files, the registry, and gateway state. Build the daemon first, then use a short gym
scratch directory so the daemon socket path fits:

```sh
pnpm --filter @slopus/happy-agent build
D=$PWD/.context/clip-demo
HAPPY_AGENT_GYM_SCRATCH_DIRECTORY=/tmp/hclip \
  pnpm --filter @slopus/happy-agent-gym-tests exec tsx \
  ../happy-bot-invite-bridge/demo/isolatedDaemon.ts "$D" "$HOME/.codex/auth.json"
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8790
```

With the tunnel host and the bot ID from `$D/bot.json`, follow the package README: create the
invitation, append its printed `groupUserId` to `$D/allowed.json` (a JSON string array) and wait
for the export, run `mark-approved`, then start `serve` against `$D/registry.json` on 8789 and the
edge on 8790. Verify:

```sh
curl -sS https://HOST/.well-known/apple-app-site-association
node packages/happy-bot-invite-bridge/demo/verifyInvite.mjs "$D/verify-invite.json"
```

On macOS, a sandboxed shell refuses the local listeners and outbound tunnel; run these commands
with explicit local-network permission. Stop with SIGTERM so the gym disposes its installation,
then remove the scratch directory.
