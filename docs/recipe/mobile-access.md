# Set up or repair Mobile Access

Use this recipe when someone wants to control Happy Desktop from Happy Coder on their phone,
or control terminal Claude Code/Codex sessions remotely. Mobile access is optional and the phone
holds the account's primary key. Messages and session content are end-to-end encrypted between
the computer and phone. This is not a migration to direct phone-to-Agent transport.

## One guided setup

Use the Mobile Access flow in Desktop onboarding or **Settings → Mobile Access**. Both local
entry points use the same guided setup: opt in; get Happy Coder from the App Store or Google
Play while Desktop prepares the legacy Happy CLI; confirm the app is open; scan the device QR
inside Happy Coder and approve; wait for terminal setup to finish. The store QR downloads the
app; the device QR authorizes the computer. There is only one device-authorization scan.

If the computer is already linked, reuse that link and finish terminal setup without asking for
another scan or forced login. A saved link can be offline; do not call it connected until live
status confirms it. The CLI and native Agent still have distinct machine registrations.

To control a terminal session remotely, start it with `happy claude` or `happy codex`. Merely
running vanilla `claude` or `codex` does not put that session under Happy's remote control. The
phone can also start sessions when the corresponding computer and daemon are online.

## Diagnose without destroying the existing setup

- Never delete, reset, or recursively repair `~/.happy` or `HAPPY_HOME_DIR`. Happy Agent shares
  that directory; existing history, configuration, and account state must remain intact.
- Never prescribe `happy auth login --force` as routine onboarding. An account/server mismatch
  requires the user's intended account/server choice, not silently replacing either login.
- Desktop currently requires an available Node.js/npm installation to prepare the terminal CLI.
  Inspect the reported prerequisite/PATH/permissions error. Do not run a global install with
  sudo or change ownership recursively as a generic fix.
- The CLI must support `happy auth desktop --check`, whose exact marker is
  `happy-desktop-link-v1`. The marker names the local command capability, not V1 account auth;
  this handoff supports V2 credentials. If the published CLI lacks it, stop and explain that
  compatible builds are required. Do not fall back to interactive or forced authentication.
- If phone approval succeeds but terminal setup fails, retain the native pairing and retry the
  shared flow. `happy auth desktop` performs credential handoff and starts the daemon; it is a
  mutation, not a read-only diagnostic. Run it only within the user's authorized repair task.
  Its direct error can distinguish account/server refusal from daemon startup/readiness failure.
- Do not print or ask the user to paste credential files, tokens, QR payloads, or private keys.
  CLI credentials are at the shared home root; native credentials are beneath `agent/happy/`.
  Validate status through product tools; do not reconstruct authentication by copying secrets.
- Readiness is checked during setup, not continuously. In the current implementation a CLI
  daemon stopped by reboot or a crash is not automatically restarted by ordinary Desktop
  startup. Explain this limitation; use the authorized setup action to start it again. Do not
  confuse native Desktop connectivity with terminal spawn/resume readiness.

Remote Agents keep their existing Agent-only Mobile Access path. Connect them through that
Agent's Settings; local Desktop's automatic terminal linking does not install a CLI on a remote
machine or transfer credentials there. Read the remote deployment recipe if that is the task.

Lost accounts, phone reinstalls, and conflicting saved accounts require a deliberate recovery
conversation. Preserve both sides until the user chooses the account to keep. Do not initiate
notifications or an older-user promotion campaign as part of repair.

## Unlink or switch phone account

Use this when someone wants this computer off their phone, wants to start over, or wants the
computer on a different Happy account. Adding another phone to the same account is not an
unlink: restore the account on the new phone instead.

- Unlinking (**Settings → Mobile Access → Disconnect this computer**, or the Happy integration
  unlink action) removes this computer from the Happy account. The computer and the chats this
  computer published disappear from the phone. Local history stays on this computer. Happy CLI
  sessions on the same account and the terminal CLI login are not touched. Before unlinking, make
  sure the person understands their chats leave the phone; do not unlink as routine
  troubleshooting.
- Deleting the computer on the phone (the machine's **Delete** action) does the same thing. Happy
  Agent notices, or notices when it next starts, and Mobile Access returns to **Not set up**. To
  use the phone again, link again from this computer.
- If unlinking reports that Happy Agent couldn't remove this computer, Happy was not reachable and
  nothing was forgotten. The computer stays linked but offline. Check the connection and run the
  unlink again; it resumes where it stopped. If the person would rather keep the link, start
  Mobile Access again to reconnect. Never delete `access.key` or `machine.json` by hand to force a
  local-only unlink: that leaves the computer on their phone with nothing left that can remove it.
- To switch accounts, unlink, then choose **Connect phone** and scan the QR code with the phone
  signed in to the account they want. This computer joins that account as a new computer and
  republishes its current chats with recent history; the old account no longer lists it. Older
  Happy Agent versions only dropped the local login and left the computer on the old account.
- The terminal CLI keeps its own login, which may be a different account. Manage it separately
  with **Remove saved terminal login**; unlinking the phone does not change it.

## Completion checks

Confirm the intended account remains in place, native status is truthful, and terminal daemon
setup completed. After an unlink, Mobile Access shows **Not set up**; ask the person to confirm the
computer is gone from their phone. After switching accounts, confirm the computer appears on the
new account's phone. Where real devices and authority are available, verify a Claude/Codex start
and resume from the phone. Do not claim a real-device check from build or unit-test results.
