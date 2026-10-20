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
reply tell the model so: an agent working for another agent must hand over paths or artifact IDs
for the agent the user talks to to present again.

## A failed snapshot never costs a generated image

Generation is billed. If the snapshot of a generated image fails, the generation still succeeds
without a presentation, and the model is told the image could not be shown and how to present
it. `present_files` has no such cost, so its snapshot failures fail the call.

## Showing a page is reviewed

`show_page` only records an address, but the client then opens that page through the agent's
network and runs its scripts in the chat, which can reach the agent's local servers and the
internet. Kirill asked for every call to be reviewed in Auto, so the reviewer sees and decides on
the exact URL and title before the user is shown anything.
