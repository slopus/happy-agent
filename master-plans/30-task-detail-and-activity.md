# Master plan 30: Task detail, live activity, and where things open

**DELIBERATELY DRAFT: captured from Kirill's feedback on 2026-10-29, not
scheduled, not an accepted design.** The sidebar rows themselves are being
worked on now; everything here is the larger direction around them. Nothing
below is approved work. Do not build from this plan until Kirill reopens it.

Newer statements from Kirill win over older ones; this records the latest.

## Sidebar without nesting

In the stem-cell sidebar, rows are top-level only. Subtasks and workers no
longer appear nested under their task. Related tasks are grouped by the Focus
Agent into sections. A subtask that matters on its own is promoted to a
top-level task. The classic sidebar keeps its nesting.

## Task detail view

- A single click on a task opens its top-level chat, as now.
- A double click transitions into the task's detail view, like a Telegram
  forum or workspace with nested chats. It still opens on the top-level chat
  by default.
- The detail view lists the lower-level chats: sub-agents and workers, each
  with how much it cost and how long it ran. Archived ones are faded.
- Rows there use a smaller icon, otherwise roughly the same row as the
  sidebar.

## Pinned header and live activity

- A task can pin messages and artifacts. They show in a pinned header at the
  top of the chat: that is how the things you will want to click are surfaced.
- A live activity strip, in the spirit of Apple's Live Activities / Dynamic
  Island, shows what the agent is doing now. It probably sits under the tab
  the agent uses, and its entries are shortcuts that can open other tabs.
- What the activity shows is set by the agent through the same tool family as
  set_status and stories, not computed by the client ("could this just be a
  prompt?").
- Line changes: show the total for the task and for each workspace it owns,
  near the activity button. A stats line like this is also a candidate for the
  middle line of a three-line sidebar row.

## Where things open

- An artifact opens large on the right; if the side pane was closed, it opens
  wide.
- A website opens large on the right, the same way.
- Files open as a narrow tree, about a third of the main content area, with
  "Select a file to preview" beside it. Picking a file fills the other two
  thirds. If the side pane was closed, it opens at a small initial width.
  Looking at files alone stays possible.
- A workspace is a conversation plus files. Opening one selects the
  conversation on the left as a tab and opens its file tree on the right; both
  can be selected together.
- A sub-agent opens to the right. A referenced top-level task navigates to it
  instead.
- Cmd-click opens to the right. Hover makes clear when a click will jump.
- Back restores the page exactly, including the split layout and whether the
  activity panel was expanded, even if the page was torn down while the person
  visited others.
- The side pane stays: chatting alongside a browser window needs it. Files in
  the side pane become less important.

## Open questions

- Exactly where the live activity lives: under the agent's tab, or a global
  island.
- Whether artifacts show in the detail view list, the pinned header, or both.
- Whether the machine a task runs on is worth showing (probably not).

## Bugs noted alongside

- Not every sidebar row can be dragged.
