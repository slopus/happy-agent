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
