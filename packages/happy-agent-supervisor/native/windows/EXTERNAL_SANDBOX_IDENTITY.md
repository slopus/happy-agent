# A separate sandbox identity for workspaces outside the Windows profile

Setup version 10 gives sandboxed commands for workspaces outside the Windows user profile their
own Windows accounts and group. This document explains the flaw it fixes, why it needs one
elevated setup, every alternative that was considered, and how to verify, roll back and review
it. Everything below describes the native Windows sandbox in this directory: the pinned Codex
sources, `happy.patch`, and the supervisor in `main.rs`.

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
  administrator, so existing installations see one UAC prompt to upgrade. Everything else in this
  branch works with the existing setup version 9 and no prompt.

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
| Toggle the deny, but correctly (the revocation fix alone)                    | That is what the lower commits do now, as a fallback. It is correct but still rewrites the whole profile on every switch between kinds of workspace, and leaves a running command exposed when another workspace's setup revokes its deny.                                                                                                                           |
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

- **Existing installations** (setup version 9 written by this installation, canonical state
  directory): the first sandboxed command after the upgrade, including a background Git scan,
  finds the installation outdated. Automatic setup is allowed to upgrade an installation's own
  accounts, so it opens the UAC prompt once.
- **New installations:** unchanged, one prompt at first use, which now creates all four accounts.
- **Explicit state directories** (`HAPPY_WINDOWS_SANDBOX_HOME`) never prompt automatically. Run
  `happy-agent sandbox setup`.
- **Declined or failed:** the attempt is recorded in `.sandbox\setup-attempt.json`, and no later
  command reopens the prompt. Until setup succeeds, sandboxed commands fail with "A previous Happy
  Windows sandbox setup attempt did not complete … Run `happy-agent sandbox setup --retry`". That
  includes Git scans, so the Git panel shows changes as unavailable. If the prompt is still open
  or its outcome is unknown, finish it or restart Windows before retrying; a retry never overlaps
  a pending helper.
- `HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1` blocks every provisioning path, as before.

## Verify

```powershell
happy-agent sandbox status          # "configured", Setup version: 10
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

- **Rolling back to a version-9 build.** A version-9 build sees a newer record, which it never
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
Yes, with this commit as written: every existing installation upgrades on its first sandboxed
command, whether or not it ever uses an outside workspace. See the next answer for how to avoid
that.

**Can it be optional or lazy, prompting only when an outside workspace is first used?**
Yes, and that is the recommended next step before this ships widely. It is not part of this
commit, because it touches readiness, the setup gate, the provisioning payload and the
firewall/WFP account lists, and needs its own tests. The design:

1. Keep setup version 9 as the version of the shared accounts, so an inside-only installation is
   ready without upgrading.
2. Track the external pair separately (the users file already stores it as an optional record)
   and check readiness per scope: inside commands need only the shared pair; outside commands
   need both.
3. On the first outside command without the external pair, run the existing automatic setup gate
   for the external scope only. That is one prompt, latched like today.
4. New installations provision all four accounts at first use, so they still see one prompt.
5. Until the external pair exists, or if the prompt is declined, outside workspaces fall back to
   the shared group: the correct toggle from the lower commits, with a notice that the workspace
   would be faster and safer after setup. Nothing breaks for a user who declines.

Under this design, users who never open an outside workspace never see a second prompt. Users who
do see it once, at the moment it explains itself.

**What happens if the user declines?**
Today: sandboxed commands, including Git scans, fail with a message pointing at
`happy-agent sandbox setup --retry`, and no further prompt appears on its own. With the lazy
design, only outside workspaces would be affected, and they would keep working on the fallback.

**What about managed or enterprise machines, and standard users?**
Creating local accounts may be blocked by policy, and a standard user cannot approve the prompt
without administrator credentials. Both were already true for Happy's first-use setup, so this
adds no new class of requirement, but it does add a second moment where one is needed. An
administrator can run `happy-agent sandbox setup` once for the user, or deploy it with the rest of
the installation. The lazy design limits the impact to machines that actually use outside
workspaces.

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
The lower commits do exactly that, as the fallback. It is correct, but each switch between an
inside and an outside workspace still rewrites the entire profile, which is the expensive
operation this whole branch is about, and a command that is already running can lose its deny.
The second group removes both.
