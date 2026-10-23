# A separate sandbox identity for workspaces outside the Windows profile

Setup version 10 gives sandboxed commands for workspaces outside the Windows user profile their
own Windows accounts and group. This document explains the flaw it fixes, why it needs one
elevated setup, when that setup is asked for, every alternative that was considered, and how to
verify, roll back and review it. Everything below describes the native Windows sandbox in this
directory: the pinned Codex sources, `happy.patch`, and the supervisor in `main.rs`.

## Summary

- Every Happy sandbox command used to run as one of two accounts in one group,
  `HappySandboxUsers`. Read denies attach to that group.
- A workspace **outside** the profile (for example `D:\work\app`) must not read the profile, so
  its setup denies `C:\Users\<you>` to the group. A workspace **inside** the profile must read
  its own folder, so its setup removes that deny. One group cannot hold both, so the deny on the
  profile root was toggled whenever work moved between the two kinds of workspace, and every
  toggle rewrote the inheritable ACL of the entire profile tree.
- Setup version 10 adds `HappySandboxOfflineX`, `HappySandboxOnlineX` and their group
  `HappySandboxUsersExternal`. Commands for outside workspaces run as those accounts, and the
  profile is denied to the external group once and permanently. Nothing toggles the profile ACL
  any more.
- Creating local accounts and groups and changing firewall and WFP rules requires an
  administrator, so it needs one UAC prompt. That prompt is deferred: it is asked for only the
  first time a workspace **outside** the profile needs a sandbox, or by
  `happy-agent sandbox setup`. A user who only works inside the profile keeps running on the
  existing accounts exactly as on setup version 9 and never sees it. If the prompt is declined or
  unavailable, outside workspaces fail with a clear message. Nothing falls back to a weaker
  sandbox. Background Git scans never open the prompt. Everything else in this branch works with
  the existing setup version 9 and no prompt.

## The problem in detail

### One group, two incompatible deny sets

Happy's restricted tokens are created with `WRITE_RESTRICTED` (`token.rs`). For such a token, the
restricting SIDs (Codex's capability SIDs) are only checked for **write** access. A read is
decided by the token's ordinary user and group SIDs alone. A deny-read rule can therefore only
target something the account is a member of: the account itself or `HappySandboxUsers`.

Setup reconciles the group's deny-read set to the paths the current command needs
(`deny_read_state.rs`): it applies the requested paths and revokes the ones it recorded earlier
and no longer wants. The requested set for one workspace comes from
`resolveHostDeniedReadPaths` in Happy Agent Compute: credential paths such as `.ssh`, `.aws` and
`.npmrc` for everyone, plus the profile root itself unless the workspace is strictly inside the
profile. So the group's desired set alternates:

| Workspace                     | Profile root in the deny set |
| ----------------------------- | ---------------------------- |
| `C:\Users\<you>\code\app`     | no                           |
| `D:\work\app` or `C:\src\app` | yes                          |

### What each change costs

The profile root deny is inheritable (`(OI)(CI)`). Adding or removing it makes Windows rewrite the
inherited entries of every file and folder under the profile: `AppData`, every repository, every
`node_modules`. On a developer machine that is hundreds of thousands of objects and minutes of
work, and it ran inside sandbox setup, which every command paid for before this branch.

### What the shipped build (0.4.86) actually did

Two defects in the pinned code made it worse than a toggle:

1. **A deny-read ACE was never removed.** `revoke_ace` called `SetEntriesInAclW` with
   `REVOKE_ACCESS`. That mode removes only allow and audit entries, so deny entries survived,
   while `SetNamedSecurityInfoW` still rewrote the DACL and re-propagated inheritance through the
   whole tree. Once any outside workspace had run a command, `HappySandboxUsers` was denied the
   profile for good. Every workspace inside the profile lost read access to its own folder, and
   each inside setup that followed an outside one walked the profile again without removing
   anything.
2. **The record of applied denies could lose a path.** Setup applied ACEs first and recorded them
   in `deny_read_acl_state.json` afterwards, and the record was rewritten in place. A setup killed
   in between left a deny no record listed; two setups running at once could overwrite each
   other's record; and a kill during the write left a file every later setup failed to parse.

### The incident

On a developer machine in October 2026 this combined with the launch storm that the rest of this
branch fixes:

- Git scans and shell commands each started a sandbox: a setup refresh, a logon, a private
  desktop. lsass handle counts and DWM video memory grew without bound and the whole machine
  lagged.
- Supervisors killed on a timeout left their setup helpers running. Many stuck setup helpers were
  observed, some of them waiting to walk the profile.
- `C:\Users\<user>` carried `HappySandboxUsers:(DENY)(R)` and the inheritable
  `(OI)(CI)(IO)(DENY)(R,GR)`, inherited by every repository under the profile. Every workspace
  showed "Git changes are unavailable".
- `deny_read_acl_state.json` listed `C:\Users\<user>` for the `HappySandboxUsers` SID. Removing it
  from the file did nothing, because revocation could not remove a deny anyway. The repair was a
  manual `icacls C:\Users\<user> /remove:d HappySandboxUsers` and a long propagation.

## What changes, by commit

The fixes that need no elevation are below setup version 10 in the stack and work with the
existing setup:

| Commit                                                                          | Effect on the profile deny                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop orphaned sandbox setups and serialize deny-read sync                       | Setups no longer pile up, and concurrent setups no longer overwrite each other's record.                                                                                                                                                                                               |
| Run Windows Git scans / shell commands in one sandbox per workspace             | Setup runs once per long-lived sandbox instead of once per command.                                                                                                                                                                                                                    |
| Re-assert a long-lived sandbox's deny-read ACLs before each command             | Closes the exposure window described below.                                                                                                                                                                                                                                            |
| Make deny-read revocation work and survive interrupted setups                   | Revocation removes deny entries; a revoke with nothing to remove no longer walks the tree; the record is written before applying and replaced atomically; every setup checks the profile root's actual ACL and removes a deny its group holds there that it neither wants nor records. |
| **Give workspaces outside the profile their own sandbox accounts (version 10)** | The profile is denied to `HappySandboxUsersExternal` permanently. `HappySandboxUsers` never carries it.                                                                                                                                                                                |

### No user ever has to run icacls

With the revocation fix, every setup for a workspace inside the profile checks the profile root's
real ACL, not only the record, and removes a `HappySandboxUsers` deny it finds there. That covers a
deny left by 0.4.86's broken revocation, by a crash between applying and recording, by a lost
record, or by a hand-edited state file. It runs without elevation, because the user owns their
profile, and it costs one ACL read when there is nothing to remove. On version 10 the first
inside-profile setup after the upgrade performs this cleanup, so the old model's deny disappears
on its own.

The profile root is the only path the old model both applied and removed. The credential paths
(`.ssh`, `.aws`, …) are wanted by every workspace, stay denied, and are tracked by the record as
before.

One related leftover is not cleaned up automatically: 0.4.86 created empty placeholder files and
folders (`happy.toml`, `AGENTS.md`, `AGENTS_SECURITY.md`, `mcp.toml`, `.gitconfig`,
`.gitmodules`, `.agents`, `.codex`) in projects so it could deny writes to them. This branch stops
creating them, but does not delete existing ones, because an empty file in a user's project may be
theirs.

## The exposure window

With the long-lived scan worker and shell runner, setup runs when the sandbox starts, not before
each command. Once revocation works, this sequence becomes possible with one group:

1. The outside workspace's runner starts. Its setup denies the profile to `HappySandboxUsers`.
2. An inside workspace's runner starts. Its setup revokes that deny.
3. The outside workspace's runner keeps running commands, and they can now read the profile.

A one-shot command had the same flaw, but only for the duration of one command. A runner could
keep it for as long as it lived. The reverse also held: a deny applied for an outside workspace
cut an inside workspace's long-lived sandbox off from its own folder.

In practice the window never opened in 0.4.86, because the revoke in step 2 removed nothing; the
failure was the permanent deny instead. The commits are ordered so that no build in the stack has
working revocation without the fix:

- **Re-assert before each command** (below the revocation fix). Before each command, the
  served runner compares `deny_read_acl_state.json` with the bytes its own setup left there. If
  another setup changed it, the runner repeats its own setup refresh before starting the command,
  and refuses the command if that fails. A command therefore starts with its deny set in force,
  exactly like a one-shot command. The check is one small file read; the refresh runs only after a
  change. Disabling the long-lived path for outside workspaces was the other option. It closes the
  same window, but brings back a sandbox logon and desktop per command for exactly those
  workspaces, so it was rejected.
- **What remains without version 10.** A command already running when another setup revokes its
  deny runs without it until it ends. That holds for one-shot commands too, and it is inherent to
  one shared group.
- **With version 10.** The two kinds of workspace use different groups. Nothing revokes the
  external group's profile deny, so no window exists, running or not. The long-lived path stays
  enabled for every workspace. It was never turned off, so there is nothing to re-enable. The
  per-command check stays in place as a guard and almost never fires, because the record changes
  only when a workspace's deny set really changes.

## Why a separate identity

The goal: commands for outside workspaces must never read the profile, commands for inside
workspaces must read their own folder, and neither may ever change the profile's ACL again.

- **Reads are decided by group membership.** As described above, a `WRITE_RESTRICTED` token
  checks its restricting SIDs only for writes, so a capability SID cannot carry a read deny. The
  deny must target a group the account belongs to.
- **Group membership is fixed per account.** A token's groups come from the account's membership
  at logon. A group cannot be added to one command's token without being a member.
- **Changing membership, creating accounts and changing firewall or WFP rules all require an
  administrator.** That is one elevated setup, the same kind Happy already performs at first use.

Two groups with fixed memberships is the smallest arrangement that meets the goal. The external
accounts are members of both groups, so every deny the shared group carries (`.ssh`, `.aws`, …)
applies to them too, and the external group adds only the profile.

## Alternatives considered

| Alternative                                                                  | Why it was rejected                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never deny the profile root; deny only the known credential paths everywhere | No prompt and no toggling, but it loosens the sandbox. An outside workspace could read every inside repository the sandbox group was granted, plus anything in the profile an application opened to `Users` or `Everyone`: browser profiles, editor state, tokens in tools Happy does not know about. The list of credential paths is a best effort, not a boundary. |
| Fully restricted tokens, so a capability SID can deny reads                  | Every read would also have to pass the restricting SIDs, which `Everyone`-readable system folders, `Program Files`, the registry and many named objects do not grant to them. Most tools would break, and it rewrites the pinned Codex token model, the hardest code in the sandbox to review.                                                                       |
| Toggle the deny, but correctly (the revocation fix alone)                    | That is what the lower commits do. It is correct but still rewrites the whole profile on every switch between kinds of workspace, and leaves a running command exposed when another workspace's setup revokes its deny.                                                                                                                                              |
| Keep the one-shot path for outside workspaces                                | Narrows the window to one command, but brings back a logon and a desktop per command for those workspaces (the storm this branch fixes), and does not stop the profile walks.                                                                                                                                                                                        |
| Skip sandboxed Git for outside workspaces, with a notice                     | Stops the Git scan part of the churn only. Shell commands there still toggle the deny, and the Git panel goes dark for those workspaces.                                                                                                                                                                                                                             |
| Ask users to move workspaces under the profile                               | Works without code, but is not a product answer: monorepos on a second drive, `C:\src` layouts and Dev Drives are common and deliberate.                                                                                                                                                                                                                             |
| One account per workspace                                                    | Same elevation requirement, unbounded accounts, a firewall and WFP rule set per account, and no benefit over two scopes.                                                                                                                                                                                                                                             |

## What the elevated setup does

It runs once, through the existing `happy-sandbox-setup.exe` and the same consent prompt Happy
already uses at first use:

- **Accounts:** creates the local accounts `HappySandboxOfflineX` and `HappySandboxOnlineX` with
  random passwords, stored DPAPI-protected in the sandbox state like the existing pair, and hides
  them from the sign-in screen. Windows limits local account names to 20 characters.
- **Group:** creates `HappySandboxUsersExternal` ("Happy sandbox accounts for workspaces outside
  the user profile (managed)") and makes both new accounts members of it and of
  `HappySandboxUsers`.
- **Firewall:** the existing Happy offline rules (`happy_sandbox_offline_block_outbound`,
  `happy_sandbox_offline_block_loopback_tcp`, `happy_sandbox_offline_block_loopback_udp`,
  `happy_sandbox_offline_allow_loopback_proxy`) now list both offline accounts. No new rule names.
- **WFP:** the persistent filters under the existing "Happy Windows Sandbox WFP" provider and
  sublayer match both offline accounts with one user condition, so every scope shares one network
  boundary.
- **Record:** writes setup version 10 with all four accounts.

The profile deny itself is applied by the first ordinary, non-elevated setup for an outside
workspace, and is never removed afterwards.

### When the prompt appears, and what happens if it is declined

Setup version 10 is what this build writes, but readiness is decided per scope. A record at
version 9 or 10 serves workspaces inside the profile with the shared account pair, as it always
has. Workspaces outside the profile need version 10 with the external accounts. So the prompt is
opened only by the first command that needs accounts that do not exist yet:

| Case                                                                                   | First sandboxed command inside the profile                         | First sandboxed command outside the profile                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| New installation (no record)                                                           | One prompt. It provisions all four accounts and writes version 10. | The same single prompt, whichever command comes first.                                                          |
| Existing version 9 installation, inside workspaces only                                | No prompt. Runs as the shared pair, as on version 9.               | Not applicable.                                                                                                 |
| Existing version 9 installation, first outside workspace                               | No prompt.                                                         | One prompt. It adds the external pair and the record becomes version 10. The shared pair keeps its passwords.   |
| Outside approval declined or failed                                                    | Keeps working.                                                     | Fails with "needs a one-time administrator approval" and the retry command. No further prompt until `--retry`.  |
| Prompt unavailable (no interactive desktop, such as a daemon over SSH or in session 0) | Keeps working.                                                     | The attempt fails and is latched as declined, with the same message. Run `--retry` from an interactive session. |
| Daemon already elevated                                                                | No prompt.                                                         | The helper runs without a prompt.                                                                               |
| Already approved (version 10 with four accounts)                                       | No prompt.                                                         | No prompt.                                                                                                      |
| `HAPPY_WINDOWS_SANDBOX_HOME` set                                                       | Never automatic.                                                   | Never automatic. The message says to run `happy-agent sandbox setup`.                                           |
| `HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1`                                                 | Never provisions.                                                  | Never provisions. The message says provisioning is disabled.                                                    |
| Record older than version 9                                                            | One prompt, a full upgrade to version 10.                          | The same prompt.                                                                                                |
| Record newer than version 10                                                           | Fails. A build never downgrades a newer record.                    | The same.                                                                                                       |

A first-time setup provisions all four accounts, because the user is already approving one prompt.
That way nobody sees a second prompt later.

Declining is never a reason to run an outside workspace in a weaker sandbox. Outside workspaces
fail with a message that names the folder kind, the one-time approval and the exact command, for
example "Workspaces outside your user folder need a one-time administrator approval. A previous
request did not complete. Run `happy-agent sandbox setup --retry` to ask again." The failure is
shown where the command ran: a shell command returns it as the tool error, the Git panel shows
changes as unavailable with the message, and `happy-agent sandbox status` reports it.

#### Attempts are latched per scope

- An automatic attempt for the profile scope records its outcome in `.sandbox\setup-attempt.json`.
  An automatic attempt for outside workspaces records it in `.sandbox\setup-attempt-external.json`.
  A declined outside prompt therefore never blocks the repair of a workspace inside the profile.
- An automatic attempt is refused when its own file exists. A completed failure of the other
  scope's file does not block it.
- Explicit setup is refused when either file exists, and says to use `--retry`. `--retry` asks
  again unless an earlier helper may still be running.
- Two elevated helpers never overlap. If any file records an attempt of the current boot that did
  not complete, every other attempt is refused until it finishes or Windows restarts.
- A successful attempt provisions every account, so it removes both files.

#### Background scans never open the prompt

Git scans run for every watched workspace each time the daemon starts. If they could open the
prompt, a restart would show one with nothing on screen to explain it. Scans therefore mark their
launch as a background launch, and so does every `--worker` supervisor. A background launch never
opens the prompt, for first-time setup or for repair, in either scope. It fails with "Happy needs a
one-time administrator approval before it can read Git changes here. Run
`happy-agent sandbox setup`, or start an agent in this workspace." For an outside workspace the
message says "in folders outside your user folder". Only an agent command, which follows a user's
message in that workspace, or `happy-agent sandbox setup` may open the prompt.

#### Passwords survive the upgrade

The elevated helper used to reset the passwords of every sandbox account each time it ran, and to
write the users file non-atomically. With deferred setup it runs while workspaces inside the
profile are active, and a command logging on between the reset and the file write would have
failed its logon. The helper now reuses the recorded passwords of accounts that already exist,
generates passwords only for accounts it creates, and always replaces the users file in one step.
If the existing file cannot be read and decrypted as a whole, it generates new passwords for all
four, as before.

## Verify

```powershell
happy-agent sandbox status          # "configured"; and either "Workspaces outside your user
                                    # folder: ready." or "...: not set up yet."
Get-LocalUser HappySandbox*         # four accounts, all enabled
Get-LocalGroupMember HappySandboxUsersExternal   # HappySandboxOfflineX, HappySandboxOnlineX
icacls $env:USERPROFILE              # HappySandboxUsersExternal:(DENY)(R) once an outside
                                     # workspace has run; no HappySandboxUsers deny
Get-NetFirewallRule -Name happy_sandbox_offline_* | Get-NetFirewallSecurityFilter
                                     # LocalUser lists both offline accounts' SIDs
```

Then, from an outside workspace, run a sandboxed command that reads `$env:USERPROFILE` (it must
fail), and run Git status in an inside workspace (it must succeed). Switching between them must
leave the `icacls` output unchanged.

## Uninstall and rollback

- **Uninstall.** The packaged uninstaller's `clean_up_packaged_windows_sandbox` removes both
  groups, unhides and deletes all four accounts, and removes the firewall rules and WFP filters.
  The `happy-agent` CLI does not expose it. By hand, from an elevated shell:

    ```powershell
    'HappySandboxOffline','HappySandboxOnline','HappySandboxOfflineX','HappySandboxOnlineX' |
        ForEach-Object { net user $_ /delete }
    'HappySandboxUsers','HappySandboxUsersExternal' | ForEach-Object { net localgroup $_ /delete }
    Get-NetFirewallRule -Name happy_sandbox_* | Remove-NetFirewallRule
    ```

    Deleting a group leaves its ACEs behind as unresolvable SIDs. Remove the profile deny first
    with `icacls $env:USERPROFILE /remove:d HappySandboxUsersExternal` while the group still exists.

- **Rolling back to a version-9 build.** An installation that never approved the outside
  accounts is still on its version 9 record, and a version-9 build runs on it untouched. An
  installation that did approve has a version 10 record, which a version-9 build never
  downgrades automatically, so its sandboxed commands fail until `happy-agent sandbox setup` is
  run deliberately (one UAC prompt). That rewrites the record as version 9. The external accounts
  and group stay behind unused, because a version-9 build does not know them; remove them as
  above if wanted. The profile deny on the external group affects only those unused accounts.
- **Dropping the commit.** Everything below it works with setup version 9. Without it, the lower
  commits still toggle the profile deny correctly, with the cost and residual window described
  above.

## Security properties

| Property                                    | 0.4.86                                                       | Without version 10 (lower commits)                            | Version 10                                     |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------- |
| Outside workspace can read the profile      | no, but only because the deny could never be removed         | no at command start; yes for a running command after a revoke | never                                          |
| Inside workspace can read its own folder    | no, after any outside workspace ever ran                     | yes, except while an outside deny is in force                 | always                                         |
| Profile ACL rewritten                       | on every inside setup after an outside one, removing nothing | on every switch between kinds of workspace                    | once, at the first outside workspace           |
| Stale deny after a crash or lost record     | stuck until fixed by hand                                    | removed by the next setup                                     | removed by the next setup                      |
| Credential paths (`.ssh`, `.aws`, …) denied | yes                                                          | yes                                                           | yes, to both groups                            |
| Network boundary for offline commands       | firewall + WFP for one account                               | same                                                          | one shared boundary for both offline accounts  |
| Accounts on the machine                     | 2 accounts, 1 group                                          | same                                                          | 4 accounts, 2 groups, all hidden and non-admin |

## FAQ

**Why force a UAC prompt on users?**
Because the only way to stop rewriting the profile's ACL, while keeping outside workspaces out of
the profile, is a second group with fixed membership, and only an administrator can create one.
The prompt is the same one Happy already shows at first use, it appears once, and afterwards no
Happy command ever touches the profile ACL again. Without it, the product either keeps rewriting
the whole profile on every switch between workspaces or gives outside workspaces read access to
the profile.

**Does every user get the prompt?**
No. A new installation sees one prompt at first use. An existing installation on setup version 9
sees it only when a command first needs the accounts for a workspace outside the profile. A user
who only works inside the profile never sees it, and their commands keep running as the shared
account pair, unchanged.

**Can it be lazy, prompting only when an outside workspace is first used?**
It is. Readiness is checked per scope. Commands for workspaces inside the profile need only the
shared pair, which a version 9 or version 10 record provides. Commands for workspaces outside it
need the external pair, so the first one runs the automatic setup gate for that scope, and the
user sees one prompt at the moment it explains itself. The prompt is latched like any other
attempt. New installations provision all four accounts at first use, so they still see only one.
Background Git scans never open it.

**What happens if the user declines?**
Only outside workspaces are affected. Their commands, including Git scans, fail with a message
that says they need a one-time administrator approval and names
`happy-agent sandbox setup --retry`, and no further prompt appears on its own. Workspaces inside
the profile keep working. Nothing falls back to a weaker sandbox: a fallback to the shared group
would leave a running command exposed whenever another workspace's setup revoked the profile
deny, which is the flaw this change removes.

**What about managed or enterprise machines, and standard users?**
Creating local accounts may be blocked by policy, and a standard user cannot approve the prompt
without administrator credentials. Both were already true for Happy's first-use setup, so this
adds no new class of requirement, but it does add a second moment where one is needed. An
administrator can run `happy-agent sandbox setup` once for the user, or deploy it with the rest of
the installation. The prompt is deferred, so the impact is limited to machines that actually use
outside workspaces; workspaces inside the profile are unaffected.

**Does it give the model more access?**
No. All four accounts are non-administrator, hidden, and reachable only through Happy's restricted
tokens. The external pair can read strictly less than the shared pair: everything the shared
group is denied, plus the profile.

**Does it add network access?**
No. The offline external account is inside the same firewall and WFP boundary as the existing
offline account. The online external account has the same access as the existing online account.

**Will users still need icacls?**
No. Every setup for an inside workspace removes a `HappySandboxUsers` deny it finds on the profile
root, whether or not any record lists it. That runs without elevation and is part of the commits
below this one.

**Could the official 0.4.86 build leave the profile deny stuck after a crash or a kill in the
middle of setup?**
Yes, in three ways, and more fundamentally it could never remove that deny at all:

1. Its revocation removed no deny entries, so the deny stayed after the first outside workspace
   ran, crash or not.
2. It applied the deny before recording it, so a setup killed in between left a deny no record
   listed. The supervisor's kill-on-close job in this branch makes such kills more likely, which is
   why the record is now written first.
3. Concurrent setups could overwrite each other's record, and a kill during the write left a file
   that every later setup failed to parse.

All three are fixed without elevation in the lower commits: the setup lock serializes the
reconcile, revocation removes deny entries, the record is written before applying and replaced
atomically, and every setup checks the profile root's actual ACL.

**Why not just fix revocation and keep one group?**
The lower commits do exactly that. It is correct, but each switch between an
inside and an outside workspace still rewrites the entire profile, which is the expensive
operation this whole branch is about, and a command that is already running can lose its deny.
The second group removes both.
