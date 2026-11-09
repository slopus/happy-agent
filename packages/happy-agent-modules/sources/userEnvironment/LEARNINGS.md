# User environment — learnings

## One record per device, and an absent field keeps its value

Steve asked for each person's reported environment to be tracked so agents learn when it changes,
starting with the time zone and then languages, clock, first day of the week, and calendar. It was
first one merged snapshot per person, but two devices set up differently then overwrote each other
on every report, so Steve asked for one record per device. A report that leaves a field out has not
reported it, so that device's stored value stays. Nothing can be cleared.

A turn uses the environment of the device its message came from; a message from no device uses
the device that reported most recently in the last 30 days. Devices older than that, and any beyond
the 32 most recent, are forgotten at the person's next report.

The device is named by its client. The daemon verifies no identity that means one device across
transports: the standalone token is shared, Happy Cloud relay messages carry none, a team token
names a sign-in session, and a mobile-connector phone's verified ID covers only that transport and
would split one phone into two devices. The ID is scoped to its owner and carries no authority.

## Agents are told what changed against what they were last told

Marking every agent of a person as pending would mean enumerating and writing to each agent on
every report. Instead each agent keeps what it was last told, and from which device, in its own KV
and compares it with the record its next accepted message uses, in the same transaction as the notice. A
pending notice is just that difference, so idle agents are never woken, several changes coalesce
into one, a change undone before the next turn says nothing, and a rolled-back message
redelivers. An agent never told receives the whole environment once on its first turn.

Only the time zone, the primary language, the clock, the first day of the week, and the calendar
are news. Steve asked that reordering secondary languages not be. Moving between devices that agree
on those is not news either; moving between devices that disagree is, each time, and the notice
says which kind of device the person is now on. A change on the device the agent already knows
about never claims the person moved.

## Bun's ICU is not Node's

Happy Agent ships on Bun, whose `Intl` differs from Node's where this module looks:

- `resolvedOptions().timeZone` corrects case but does not resolve tzdb links, so `Asia/Calcutta`
  and `Asia/Kolkata` look like two zones. Chromium reports the first and phones the second, which
  would flip a person's zone on every report. The module lists ICU's legacy names and the UTC
  aliases itself.
- `Intl.supportedValuesOf("calendar")` omits `islamic` and `islamic-rgsa`, so calendars are
  validated against a fixed list of BCP 47 identifiers.
- Display names come from ICU data and vary by version, so the notice text is fixed English
  built from the values.

Run this module's tests under Bun as well as Node when touching validation or notice text.

## The reported UTC offset is advisory

A client's offset is accepted and range-checked but never stored or shown: it follows from the
zone and the moment, and a reported one goes stale at the next daylight-saving change.
