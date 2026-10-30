# Stories — learnings

## Off means absent, byte for byte

Stories are experimental and off by default. A person without the setting must not be able to
tell the feature exists: no tool, no change to the system prompt or tool schemas, no events, and
`404 not_found` from every route, exactly as for an unknown route. Only the JSON value `true`
turns it on, so a stray string or number never does. Keeping the `story` artifact type out of
the artifact tools' schemas (`artifactToolTypeSchema`) is part of this: adding it there would
change every opted-out person's tool definitions.

## A story is an artifact no ordinary writer can touch

A story's content is versioned as a `story` artifact so it gets versions, uploads, content
storage, and tombstones for free. The artifact catalog, artifact tools, and artifact routes must
not become a side door around the story's own rules — author-only drafts, Post naming a version,
audience-scoped reads. So ordinary artifact writes refuse story artifacts, the catalog leaves
them out, and artifact `artifact.*` events are not emitted for them; readers learn of stories
through `story.*` events instead.

## Events are worked out after commit on their own context

Each `story.*` event carries every reader's own view (`seen`, `myReaction`, `viewCount`), so it
is computed per audience member after the write commits. Computing it inside the commit
callback with the writing context failed with "the agent storage transaction carried by this
context has ended". The module now detaches a named `stories-events` context with the agent
database in `beforeStart` and works events out there, chained one after another.

## The agent drafts; only the person posts

"Post it" means "make me a draft". The tool never posts and is not reviewed in Auto, because a
draft is visible only to its author. Read only refuses it. A revision names the `baseVersion`
it revises; if the person edited the draft since, the call fails and shows the current draft so
the agent can start from the person's edits rather than overwrite them.

`draft_story` is deferred like every common tool, so the model first meets it through its
capability line. A live run with real inference showed that a capability saying only what the
tool does was not enough: with a social-posting skill installed, the model answered "post it" by
asking where to post, because it read posting as public. The capability line now names "post it"
and says the result is a draft only the person sees until they press Post; with it, the model
drafts the story directly.

## Agents post only what shipped, and keep their ring fresh

Kirill's direction for agent stories: a story announces a real shipped thing, never progress,
and a ring holds at most one live story per agent — only the freshest per task tree. That is a
judgement, so it lives in the `post_story` and `set_status` descriptions, not in code: the code
only refuses superseding a story outside the ring. Captions and status lines are written for a
vibe coder, so the prompts forbid hashes, versions, test counts, file names, and "14/14"-style
tallies.

## The status is a short phrase, and its length is the model's call

Rows show `statusLine` under the title in one or two short lines. Kirill first allowed about 70
characters, then wanted it shorter. The `set_status` description asks for a short phrase of about
40 characters with short examples ("Shipped to preview", "On main", "Stuck on payment sign-up").
A release briefly refused anything over 60 characters; Kirill removed that: length is guidance in
the prompt only, never a rejection or a truncation, and the model decides. The wire limit of 120
is the only hard bound. Kirill kept the tiny stage cue (`● ● [●] ○ Testing payments`), but only
when the current stage is one or two words and the whole status still fits in about 40 characters.

Kirill wanted a status that shows two deliberately aligned lines, such as
"1. Ship new onboarding\n2. Submit iOS native build", which a wrapped single line cannot. The
status, on the wire and in `set_status`, now allows exactly one `\n` between two non-empty lines,
since the row shows at most two. The tool reads `\r\n` as `\n` and refuses a lone `\r`, a second
break, and any other control character. Whether to split is the model's call, guided by the
description; clients that show one line put a space where the break is.

The status almost always stays and states plainly where the conversation is, finished work
included ("Shipped to preview", "On main"), and it changes only at key moments, never on every
step. `null` is for a status that would otherwise be untrue.

A replay of eight real conversations on gpt-6.1-sol found three status habits the first prompt
allowed, and both the instruction and the description now name them:

- **Restating the step.** Each new small request rewrote the status to the step at hand
  ("Finding the new recording", "Checking the article's links"). A follow-up question, a small
  extra request, or the next step now keeps the status, and step descriptions are named as wrong.
- **Going stale at a hand-back.** When work stopped to wait for an approval or a choice, or was
  paused, the status still described the old work. Waiting on the person's decision and paused
  are now key moments, and the agent checks the status is still true before handing back.
- **Tallies.** "136 icons counted" got through a list that only named test counts, so tallies are
  named generally.

Questions in a pure research chat still sometimes rewrite the status.

## Agents use set_status and post_story only when told to

`set_status` began deferred, discoverable only through its capability line. On the live daemon
one conversation in 865 had a status: agents never looked for it, so Kirill saw empty rows. The
tool is now always loaded wherever it is offered, and the module adds one short instruction there:
set it early, change it at key moments. That is still a prompt, never code writing statuses on an
agent's behalf.

`post_story` repeated the story. In the replay, a deferred `post_story` was never posted at any
moment where work had shipped. With an instruction alone, the agent searched for it, called
`list_stories`, saw an empty ring, and ended its turn. It is now always loaded too, for every agent
that posts to a ring. The module adds a second instruction there: post one story in the same turn
something ships or becomes ready to try, and never for progress, plans, or work still waiting for
review or approval. The last clause came from an agent that posted a story for a draft pull
request. A story needs a frame, so for a change pushed to main the description and the "nothing
shown" error tell the agent to make a screenshot or a small artifact page first, and it does.

## Only task and bot agents keep a status

The status describes a task's or a bot's sidebar row, so Kirill limited `set_status` and its
instruction to a task's or a bot's own agent, recognized by the Tasks and Bots modules' own
records (`forAgent`), and only while its person has Stories on. Subtasks, helpers, collaborators,
and project or workspace sessions get neither, even though subtasks still post to their ring.

## Read only keeps the status

`set_status` used to be refused in Read only like `post_story`. Onboarding's Good to go starts
each accepted chat on a read-only plan, so every one of them called `set_status` early, was
refused, and sat in the sidebar with an empty row: the person's first sight after onboarding.
The status changes nothing outside the person's own sidebar, so it now works in every permission
mode. `post_story`, `withdraw_story`, and `draft_story` stay refused in Read only: a read-only
chat has shipped nothing to tell a story about.

## Story pages fill the frame because the prompt says so

A live artifact page in a story frame was drawn with the side panel's 24–32 px inset unless the
page itself set `body{padding:0}`. The fix is guidance, not a renderer special case: the
`post_story` description tells the agent that a whole-artifact frame is a 9:16 portrait canvas,
and that a page made for one fills it edge to edge with `html,body{margin:0;padding:0}`. On iOS
a real agent's page then put its title under the viewer's author name and progress strip, and
its last lines under the caption and reply bar, so the description also names those bands —
the top 60 and bottom 90 CSS px — as free of text and controls.

## A repost belongs to the person

A repost copies the agent story's frames into a new draft authored by the person, with
`source: null`. Copying the agent story's `source` collided with the unique
`(source_agent_id, source_tool_call_id)` index and failed every repost; it was also wrong, since
the person, not the tool call, made the repost. `repostOf` carries the link back instead.

## Frames reference assets, never copy them

Frames name chat media or an artifact file by ID. When the asset is gone, the frame stays and
reports `available: false`; a story with no available frame cannot be posted. Only media the
person uploads in the editor becomes a file of the story artifact itself.
