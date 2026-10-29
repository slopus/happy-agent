# Stories

Short, full-screen posts of one to ten images or videos with a caption and overlays, in the
style of Telegram's stories. A story starts as its author's private draft, made by hand in the
editor or by the conversation's agent with `draft_story`, and reaches its audience only when the
author presses Post. A posted story expires 24 hours later.

```ts
const stories = new StoriesModule(
    team,
    profile,
    userSettings,
    artifacts,
    chatMedia,
    history,
    durableFunctions,
);
const stickers = new StickersModule(config, team, stories);
```

Everything is behind the experimental per-person setting `happy-desktop.experiments.stories`,
which only the JSON value `true` turns on. A person without it gets no tool, no prompt change, no
event, and `404 not_found` from every route; an author without it is left out of everyone's feed.

## What is stored where

```text
happy_agent_stories           one row per story: author, status, content JSON, artifact version
        │ id
        ▼
story artifact (type "story") story.json + media/<frameId>.<ext> for uploaded frames
happy_agent_story_seen        one mark per viewer and author: the newest story seen, by postedAt
happy_agent_story_reactions   one emoji per viewer and story
happy_agent_story_participation  who talked in which conversation, for ranking the feed
```

A story's ID is also its artifact's ID. Every content change is one artifact version, so
`artifactVersion` is what Post names and what an agent's `baseVersion` revises. Frames reference
their media by asset — a conversation's chat media, an artifact file, or the story's own uploaded
file — and never copy it; a frame whose asset is gone answers `available: false`, and a story
with no available frame cannot be posted.

Ordinary artifact writers never see or change a story artifact: the catalog leaves it out, the
artifact tools answer not found, and the artifact routes serve its files only to someone who may
read the story. Only `createStory`, `commitStory`, and `deleteStory` write one.

## The agent's draft

`draft_story` exists only for a person with Stories on. Without frames it takes the latest one or
two images or videos the conversation presented, preferring what the agent made over what it
read. The result is an inline `artifact` presentation with `artifactType: "story"` and
`shows: "latest"`, which clients draw with Post and Edit buttons. The call is idempotent by its
tool call ID. A revision with a stale `baseVersion` fails and shows the draft as it stands: the
person's edits win.

## Agent stories

An agent may also post a story itself, with `post_story`, to its own ring: the circle on the
sidebar row of the root task or bot of its subtask chain (`ringAgentId`). The tools —
`post_story`, `withdraw_story`, `list_stories`, and `set_status` — are offered to every agent
without a parent and every subtask, while the person its stories are for has Stories on. That
person is the last human who wrote in the conversation, or in its nearest ancestor
(`happy_agent_story_people`). An agent story is visible only to that person, never expires, and
is never edited: it ends when superseded, withdrawn, or when its task or bot is archived, and the
end is a `story.ended` event. The person may repost it as their own draft (`repostOf`), and
typing in the viewer sends their words to the agent as a message quoting the frame.

Agent stories may show a whole artifact live (`{type:"artifact"}` asset) and float artifact
windows over a frame; a person's own story may also carry one round video, uploaded into the
story artifact as `media/<overlayId>.<ext>`.

`set_status` writes the agent's `statusLine`, the row's second line. An agent cannot change its
own metadata inside its turn, so the write is the durable function `stories.set-status`.

## Feed, seen marks, and reactions

`feed` returns the caller's own circle first, then every other author with live stories, unseen
authors first and then by importance: shared work, how often the two talk, and freshness. Its
`rings` list the caller's agents with live stories, newest first; a ring's seen mark is stored
under the author key `ring:<agentId>`.
Reacting also marks a story seen. Only the author reads its viewers.

## Events

`story.*` events are worked out after commit, per member of the audience, from each member's view,
and appended to the API journal owned by that member. They run on a context detached in
`beforeStart`, because the committing transaction's context has ended by then.
