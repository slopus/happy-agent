# Stories — learnings

## A story is an artifact nobody else can see or touch

Stories came back as artifacts of type `story` so they get content storage, uploads, and
versions for free, without a parallel store. Today's clients validate artifact `type` against a
fixed list, so they must never meet one: the catalog lists stories only with `type=story`,
`artifact.*` events are never published for them, every `/v0/artifacts/:id` route answers 404
without the flag, and PATCH, delete, and file edits refuse them. The posting state (audience,
person, how it ended, who saw it) lives in this module's own tables, not in an artifacts
migration.

## Frames are images and videos from artifacts

Desktop dropped HTML-page story frames, so a frame must be an image or video. Reading a file from
the agent's machine was cut to stay in budget and removed a Full-access path: agents publish the
image or video with `create_artifact` and name it in `set_story`.

## A team post needs a person's ask

`set_story` with `audience: "team"` reaches people who never asked for it, so it is always reviewed
in Auto, and the review text tells the reviewer to allow it only when a person asked for a team
post, in the conversation or as a standing instruction. Owner posts are not reviewed.

## The story gate lives in Artifacts, closed by default

Review found side doors: agent read tools, Surface references, an idempotent create reusing a
story's ID, and a repost or post naming an ordinary artifact's ID all reached story content or
attached story state to someone else's artifact. Every Artifacts read now treats a story as
missing unless the caller names a reader (`{ memberId }` or `{ agentId }`) that this module's
gate admits: a person who may see it, or the agent that posted it or receives its replies. A
create that hits another type's ID is a conflict, and a story create that finds an existing
artifact fails. A take-down keeps its target in the call's store and ends only a live story,
inside one transaction, so a replay never ends a newer one. `get_card` shows a bot's owner stories
only to the person its turn answers.

## A reply is an ordinary message, found by index

Replies are not a separate store. A reply is the replier's own user message to the reply agent,
carrying `replyTo` in History, so it wakes the agent like any message and keeps who wrote it.
The model learns which story a reply answers from one system line written just before the
message. The prompt, the message text, and the agent loop do not change. Every story served counts its replies,
so History indexes `replyTo.artifactId` instead of scanning a whole conversation for each story.
`unread.from` grows with every person's message while the agent is unread, not only replies. A
finished turn keeps it, so the agent waking to a reply does not erase the replier's face.
