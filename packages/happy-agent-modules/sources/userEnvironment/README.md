# User environment

The environment each of a person's devices reports: time zone, languages, clock, first day of the
week, and calendar. Every device keeps its own record, so two devices set up differently never
overwrite each other, and the module tells that person's agents about the environment of the
device they are using, once and again whenever it changes.

It depends on the team module, to tell team mode from standalone and to find the authenticated
member, and on the tasks module, to find who owns an agent.

## Owners and devices

`report` and `environment` take their owner from the caller's context, as user settings do. In
team mode the owner is the member's installation-local Happy user ID, and a context without a
member throws `TeamAuthenticationError`. Standalone, the owner is `standalone`, the installation's
one person.

A device is named by its client with `deviceId`, an opaque ID it generates once and keeps. No
credential the daemon verifies identifies one device across every transport: the standalone token
is shared by every local client, Happy Cloud relay messages carry no device, a team token
identifies a sign-in session rather than a device, and only a phone paired through the mobile
connector has a verified device ID, on that one transport. The ID is scoped to its owner, so it
names a device among that person's own and carries no authority. Each device also has an optional
`deviceKind`: `phone`, `tablet`, `desktop`, or `web`.

An agent's owner is resolved when its notices are asked for. Standalone, every agent belongs to
the one person. In team mode the module walks Agent Base parentage to the root agent, so subtasks
and hidden subagents belong to the owner of the task at the root of their tree. Bots are shared in
team mode and belong to nobody, so their agents are not told.

## Reports

`report(ctx, report)` merges one device's report into that device's record. `deviceId` is
required; every other field is optional, and one a report leaves out was not reported and keeps
its stored value. Nothing can be cleared. Every report counts as the device being seen and moves
its `reportedAt`, even one that changes nothing; `updatedAt` moves only when its environment
changes. It returns the device's record and which aspects changed. A malformed field throws
`UserEnvironmentError` with code `invalid_request`.

- `timeZone` — an IANA name the runtime recognizes. Names are compared case-insensitively and
  through links, so a report naming the stored zone another way keeps the stored name. Node's ICU
  resolves links but Bun only corrects case, and Chromium reports ICU's legacy names such as
  `Asia/Calcutta` where phones report `Asia/Kolkata`, so the module lists those legacy names and
  the UTC aliases itself.
- `utcOffsetMinutes` — advisory, −720 through 840, and never stored. The offset follows from the
  zone and the moment, and a reported one goes stale at the next daylight-saving change.
- `locale` — the formatting locale, and `languages` — 1 to 16 preferred languages in order. Both
  are BCP 47 tags, stored in canonical form.
- `hourCycle` — `h11`, `h12`, `h23`, or `h24`, as `Intl.Locale` names them.
- `firstDayOfWeek` — 1 for Monday through 7 for Sunday.
- `calendar` — a BCP 47 calendar identifier from a fixed list. It is not read from the runtime,
  because Bun does not offer `islamic` or `islamic-rgsa`.

A report also forgets the person's devices that have not reported for 30 days
(`USER_DEVICE_STALE_AFTER_MS`) and any beyond their 32 most recently reported
(`MAX_USER_DEVICES`), because a browser that clears its storage returns as a new device.

`environment(ctx, deviceId?)` returns the record agents would use for a message from that device.

## Which device a turn uses

A message names the device it came from in its metadata as `deviceId`. A message with a device
that has a record uses that record. A message with no device, such as a scheduled message, one
from another agent, or one from a client that names none, uses the device that reported most
recently in the last 30 days. A malformed or unknown device is no device.

## Notices

```text
report -> that device's record changes
next accepted message of each of the person's agents
    -> pick the device for this message
    -> compare with what the agent was last told, and from which device (agent KV)
    -> system notice + KV write, one transaction
```

An agent is told five aspects: the time zone, the primary language (the first preferred
language, or the formatting locale while no languages are known), the clock, the first day of the
week, and the calendar. Secondary languages and their order are never news.

The module installs a `systemNotificationsTransact` hook that acts only at message boundaries,
just before a consumed message joins the conversation. Nothing is queued per agent: what an agent
was last told lives in its agent KV under `environment`, and a pending notice is simply a
difference between that and the record this message uses. A change never wakes an idle agent.
Agent KV outlives restarts and compaction.

- An agent never told the environment receives all of it once, naming the device's kind when it
  is known: `User environment (phone): time zone Europe/Berlin (UTC+1), language de-DE, 24-hour
clock, week starts Monday, Gregorian calendar. Their local time is now Tuesday 2026-11-10 10:30.`
- An agent told an older environment receives one sentence per aspect that changed, and the local
  time when the zone changed. When the record now comes from another device of a known kind, the
  notice first says so: `The user is now on their phone. The user's time zone changed from
Europe/Berlin to America/New_York (UTC-5). Their local time is now Tuesday 2026-11-10 04:30.`
- Moving to a device whose aspects agree says nothing; the agent only records which device it is.
  Moving between devices that disagree is news each time.
- The KV write commits with the notice, so a rolled-back message delivers it again and a
  committed one never repeats it. Several changes before an agent's next turn produce one notice,
  from what it was last told to the latest; changing away and back again produces none.

Kinds read `phone`, `tablet`, `computer`, and `web browser` in the first note, and `on their
phone`, `on their tablet`, `on their computer`, and `in a web browser` when the person moves. The
text is fixed English built from the values, never from `Intl` display names, which differ
between runtimes and ICU versions. Offsets read `UTC`, `UTC+9`, or `UTC-3:30`; local times read
`Tuesday 2026-11-10 18:30`.

## Storage

Migration `001-user-device-environments` creates `happy_agent_user_device_environments`, one row
per owner and device with its kind, its environment as compact JSON, when that last changed, and
when the device last reported, indexed by owner and report time.

## No durable work

A report is one transaction and a notice commits with the message it precedes. There is nothing
to resume after a crash, so the module does not use Durable Functions.
