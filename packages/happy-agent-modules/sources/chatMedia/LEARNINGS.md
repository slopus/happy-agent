# Chat media — learnings

## Media in chat must not live in history

The user asked for generated images and presented files to be shown inline in the desktop chat
without ever storing their bytes in the database. History records only each item's kind, name,
media type, size, and digest, plus dimensions and a ThumbHash for images; the bytes are a private,
content-addressed snapshot taken when the call ran. A snapshot instead of the source path means
editing, moving, or deleting the source never changes the chat. Agent Base still keeps the image a
generation tool returns to the model in its private provider context; that is Base's own record
and outside this module.

## What the user sees is visible only in that chat

A presentation belongs to the call that made it, in the conversation of the agent that ran it.
Parents and children do not see it, so the module's instructions and every presenting tool's
reply tell the model so: an agent working for another agent must hand over paths or artifact IDs.
The parent links text files, presents media, and mentions artifacts by their reference tags.

## Text files stay live through file links

Broad instructions to present files made agents publish Markdown snapshots that the desktop
could not preview. Instructions and the presenting tool now reserve presentations for images,
videos, PDFs, and downloads. Text, code, and Markdown use file links, which open the live file;
the same distinction applies when handing work to a parent agent.

## A failed snapshot never costs a generated image

Generation is billed. If the snapshot of a generated image fails, the generation still succeeds
without a presentation, and the model is told the image could not be shown and how to present
it. `present_files` has no such cost, so its snapshot failures fail the call.

## Live pages belong to artifacts

Kirill replaced standalone page presentations with live-URL artifacts created through
`create_artifact` with a URL, and removed `show_page` entirely. Chat Media owns only media
snapshots, and its instructions direct new live pages to artifact creation. The client loads live
pages through their recorded network, so every live create or update remains reviewed in Auto.
The legacy `page` presentation stays in the protocol and History's schema only because recorded
calls still carry it.

## What an agent reads, the user sees

Kirill asked for every image an agent reads to appear in the chat as well, at full quality. The
image readers snapshot the original file, not the scaled copy the model gets, and present it in two
columns; the model's own output is unchanged apart from one sentence saying the user already sees
it, and the instructions and `present_files` say not to present such an image again. The read is
what the model asked for, so a snapshot that fails, or a picture no client shows, costs the read
nothing: it simply shows no image. Reading a machine's files is compute's work, so `present_files`
moved to compute with the readers, and chat media no longer depends on compute; that is what lets
compute ask it to snapshot.

## Agents lay out what they present, but clients never see HTML

Kirill wanted agents to arrange presented files, such as a figure with its caption, a two-column
grid, or one wide image, without any HTML reaching a client. `present_files` takes layout HTML that
the daemon parses with parse5 into a typed tree; style values travel as normalized CSS strings
that the client package's `mediaLayoutStyleValue` accepts, so daemon and clients check one grammar
instead of keeping two serializers in step. Image generation presents in one column. Exported bots
ignore layouts and send the items in order.

## Agents lay out shown media in their reply, without a tool call

Kirill wanted agents to arrange images without spending a `present_files` call: the agent writes
the layout as ordinary HTML in its Markdown reply, and the client renders that subset inline,
parsing and checking it itself. An `<img src>` names an image the agent already showed in the
conversation, by the path it read, presented, or generated it at, so every item records its
`source` as written and resolved; nothing is ever loaded from `src`. The HTML parser moved into the
client package so desktop and `present_files` run exactly the same code, and the client also owns
the block splitter, which unlike CommonMark does not end a block at a blank line, because models
write blank lines inside their HTML. A block that resolves no image, or loses content to a limit,
stays Markdown, so a mistake never hides what the agent wrote. Guidance is one sentence and one
tiny example in the instructions. The `present_files` layout argument stays as it was.

## Layout parsing and splitting stay bounded on hostile text

A security review of layouts in reply text found no way to run code or reach unshown media, but
three ways to stall a reader. Deeply nested wrappers the subset lacks were unwrapped recursively at
an unchanged depth and overflowed the stack; every element now counts toward nesting and the node
budget, HTML deeper than 32 is dropped as truncated, and the parser never throws. The splitter
re-scanned a paragraph for every code span, and the fence check backtracked on long runs of
spaces, which made one 64 KiB reply take seconds inside an exported bot's transaction; both are
single linear scans now, with timed tests. An aspect ratio of 1:10000 at full width made a box
millions of pixels tall, so ratios are held to 1:10 through 10:1.

## A layout is followed leniently, never refused

The first version failed the call on anything outside a narrow allowlist. Kirill found that too
strict: agents write ordinary CSS, and a refused layout cost the whole presentation. The grammar
now follows CSS closely for layout properties, and a layout never fails the call: an invalid
declaration, attribute, or `img` is dropped on its own, an unknown harmless tag is unwrapped, a
dangerous tag goes with its contents, a file left out is appended, and an unusable layout is
omitted. The result tells the model briefly what was ignored, so it can fix the next one. The
security line did not move: nothing that loads a resource, positions outside the layout, names a
colour, animates, or escapes is ever kept. Only a repeated path in `filepaths` stays an error,
because it makes an `img src` ambiguous.

## Widgets in replies grow the layout subset, not a fence catalog

Kirill wanted an agent to put a chart, a Mermaid diagram, a code quote, or a changed-files list
directly into its reply with zero tool calls, as "rung 1" below inline artifacts — explicitly not
as special Markdown fences, which an earlier guided-review attempt showed cap what a model can
express. The widgets are four tags in the same media-layout HTML subset, parsed by the same shared
client parser into typed nodes, so daemon and clients still cannot disagree. The always-on prompt
grew by one clause; the authoring detail lives in the `rich-replies` native skill, keeping the
token cost off every turn. An invalid widget degrades the block to the inert text it was written
as — nothing is hidden, nothing half-drawn. `<happy-choices>` (answer-back buttons) was explicitly
left out of this phase.

## Images show at their natural size

An image without explicit sizing shows at its natural size and only shrinks to fit; `width: 100%`
fills. Screenshots from Retina displays have twice the pixels of their natural size, so items carry
`scale` from the file's recorded density, and clients use it in every layout, automatic ones
included.
