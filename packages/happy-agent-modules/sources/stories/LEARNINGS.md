# Stories learnings

## A rebuilt store needs its own migration namespace

The retired prototype shipped `stories` migrations `001-stories` and `002-agent-stories`
against `happy_agent_stories` tables. Reusing that owner for the minimal feed's different
`001-stories` and `002-story-replies` made existing installations fail startup. The minimal
feed owns `stories-v2`; its third migration removes the abandoned prototype's five tables
and the retired `stories` ledger atomically, as requested. Its initialization adopts the identical
`happy_agent_module_*` tables written by early 0.4.111 previews, preserving their stories, seen
marks, and replies. Migration identities include their module owner: never reuse an old owner
for a replacement schema, even after removing its code. Retired prototype data is discarded,
not retained or imported into the rebuilt feed.

## Public request validation comes from the published client

The prototype duplicated Stories request schemas in the daemon. With the client published,
the daemon imports its upload metadata, layers, reply and repost schemas, and the bot update
schema, so every caller and the daemon validate the same public contract.

## Replacing stale stories is part of posting

Deleting an old story before posting its replacement could leave the ring empty if posting
failed. `post_story.replaces` now removes up to twenty of the agent's own live originals and their
reposts in the new post's transaction. Foreign, repost, missing, and ended IDs are ignored;
the result reports the originals actually replaced, and events publish only after commit.

## Task owners decide whether their agents have story tools

Stories previously followed the last human sender, supported bots, and checked the setting again
inside each tool. They now check only the task owner's setting when assembling the turn's tools;
later messages and setting changes do not revoke tools already assembled. Each bot instead uses
its own Stories switch, off by default, and its originals reach non-guest members with personal
stories on while enabled.

## Posting always publishes

Kirill asked to drop the split where a task's story stayed internal to its owner until reposted:
a task agent's original now reaches everyone who joined the task, in the sidebar ring and the top
row alike. Membership changes who sees a story, so joining and leaving (and archiving) push
`story.changed`/`story.removed` to the affected readers instead of leaving clients to refetch.

## Several frames, no length limit

The prompt used to demand one live story per agent and one short video for several steps. Kirill
asked for one frame per part of an outline instead, with no duration limit; only byte limits
remain. The prompt states the viewer's 9:16 frame and the safe area agreed with the desktop
(x 48–1032, y 384–1344 of 1080×1920) in a few lines; layout stays the model's decision.

## Stories are layers, never composites

A story is base media plus ordered media layers (several videos allowed), text, and a legacy
round, each its own stored file with its own transform. The server never composes or re-encodes
them; a repost references the original's files and layers. New files arrive through the shared
streamed `POST /v0/artifact-uploads` and are hard-linked into chat media's store; only a picture
is read, to be measured, and a video's H.264 check reads box headers only. The multipart route
remains for older clients and still buffers its body.

## Startup carries the feed

Stories appeared late because the desktop asked for the feed after bootstrap. The bootstrap now
includes `storiesEnabled` and the reader's stories under its own cursor; posts arrive live as
`story.changed`.

## Multipart files keep their declared content type

Bun 1.4.4's native multipart parser replaces file content types with filename inference. It
rejected valid gallery files without an extension and accepted a PNG declared as plain text.
The API imports `undici/index.js` explicitly: Bun substitutes its native parser for bare `undici`.
This uses Undici's multipart parser on both runtimes so binary parts preserve their declared
types before Stories validates the media. Keep the gym cases with extensionless gallery names
and mismatched content types on both Bun and Node.

Chromium recordings include codec parameters in their MP4 part types. The multipart boundary
now compares each file's base media type case-insensitively, ignoring parameters; media and
round bytes must still pass the existing decoder or H.264 sample-entry check.

## Media identity comes from its contents

The image subtype previously became the snapshot extension, rejecting valid images under an
unfamiliar subtype. Image uploads use a fixed PNG name, retaining only the AVIF hint required by
the existing decoder to distinguish HEIF formats; decoded contents determine the served MIME
type. The AVIF regression runs in the Node gym lane because Bun 1.4.4's bundled image backend
rejects AVIF before measuring it. H.264 markers previously matched anywhere in a file. The video
gate now walks bounded MP4 boxes and accepts only avc1/avc3 sample entries under moov's track
sample table, so a marker in frame data or unrelated metadata cannot make another codec an
H.264 video.

## A reply quotes its story, and the quote outlives it

Kirill asked for story replies to show a rich quote, with the story's first frame paused and its
author, instead of a plain text line. He then asked that the quote be its own field on the message,
like an attachment, with the text left exactly as the person wrote it. The reply's content is now
only their words; the message's `quote` carries the story, its agent, the reposter, its caption,
and `expiresAt`, and history keeps its frame as a chat media snapshot that the message's
`story-frame` route serves after the story ends. The model still learns what was quoted: a system
notification just before the reply names the story and shows the frame as an image, the way other
private context reaches it. An image story's frame is its own snapshot; a video's is a still JPEG
the agent machine's `ffmpeg` decodes once at `post_story`, because the daemon has no video decoder.
Reposts carry the original's still. Stored stills and image ThumbHashes never reach the served
story object.

## Story tools are deferred behind one shipped-visual trigger

Making post_story eager on Oct 29 raised shipped-moment posts on gpt-6.1-sol from 0/3 to 7/9, but
it put three schemas and three capability lines in every request, and its trigger, anything
people can see or try, covered nearly every change. Kirill asked for stories only for visual or
UX changes. The three tools are deferred again with search keywords, and only post_story
contributes a capability line. Deferring saves about 1,100 input tokens per request on Opus 5.5
and about 700 on GPT-6.1 Sol.

A line that only described when stories fit ("when you ship a mostly visual change, post one")
was ignored: replaying four real top-level turns that shipped visual work, eager and deferred
alike posted 0–1 of 8. Agents report the push and stop, and most turns had no picture at hand.
The line now names the moment (before the final reply), the trigger (pushed, merged, released or
deployed a change people will see), what to do without media (take one first), that it applies
when the person only asked to sync or check status, and what to skip (backend, prompt, docs,
tests). With it, deferred posting reached 4/4 on Sol and 2/4 on Opus, with no story on three
non-visual shipped turns on either model; a version that did not name the skip list made Sol post
for a title-prompt change. The description asks for a phone-sized or cropped vertical shot, since
a full landscape screen fills only a band of the 9:16 viewer.
