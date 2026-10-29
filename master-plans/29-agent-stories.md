# Master plan 29: Agent stories

Agents post stories about what they shipped. A story shows as a ring around
that row's icon in the sidebar: coloured segments are unseen, grey are seen,
and no ring means nothing to show. Clicking the ring opens the story; clicking
the text opens the chat. The ring is only the story. It never spins.

It is the same story object as personal Stories, not a new hardcoded format:
no "kind", no fact sheets. A story is already a `story` artifact, and the change
is small:

- a frame and an overlay may embed an artifact, so a story can hold a live,
  interactive mini-app;
- a round video overlay, Telegram style, from the webcam or the camera, allowed
  on any story the person edits;
- an agent author, so the story lives in that agent's row ring and not in the
  people row;
- a new story from the same agent supersedes its stale ones in the ring instead
  of piling up;
- a repost is an ordinary draft in the normal story editor, with a "Reposted
  from <session>" chip that opens the session for anyone who can read it.

An agent's story is private until posted: only its person sees it. Reposting
makes the person the author of a story posted to the team as usual. Agent
stories do not use the 24-hour clock; they end when superseded or when the task
is archived. Stories from subtasks roll up into the root task's or bot's ring.
Typing in the viewer sends a message to that agent, quoting the frame.

Agents get `post_story` (the same shape as `draft_story`, posting to their own
ring), `set_status` (the row's second line), and a way to supersede or withdraw
a story.

Prompts are the product. The agent-facing instructions decide when to post:
only when something real shipped — a release, a merged change, a published
artifact, something the person can try — and never progress chatter. Supersede
the previous story on every new post, and withdraw stale ones: superseded work,
reverted work, things the person already acknowledged. At most one live story
per agent, and for a whole task tree only the freshest. Be aggressive about
replacing stale stories, so the sidebar never overflows with old ones. Captions
and statuses are for a vibe coder: no commit hashes, versions, test counts, file
names, or "14/14" unless the person asks; plain words about what changed for
them.

The sidebar keeps two-line rows and sections. A fixed header (Search, New,
Happy, the Focus Agent) is followed by ordinary sections the Focus Agent names
and fills; their names change from day to day. The one rule is order: sections
run from most to least important, and rows inside each section do too. "Waiting
on you" is not a section; it is the dot in the row's bottom-right corner, where a
working row shows a loading bar instead. The person can still drag anything
anywhere. The user-facing name of Prioritizing is "Focus Agent", and its prompt
follows this model.

Stories stay behind `happy-desktop.experiments.stories`.

Steps:

1. Specify the contract in the Happy Agent API, so desktop and iOS build
   against it.
2. Implement it in the daemon: the story fields, artifact frames and overlays,
   round videos, rings with supersede, withdrawal and archive endings, repost,
   feedback, the tools and their prompts, and the status line. Cover it with
   module tests and the gym.
3. Update the Focus Agent's name and prompt.
4. Ship the desktop and iOS clients against the published client package.

This is done when an agent that ships something posts one story into its task's
ring that only its person sees; posting again replaces it; archiving the task
ends it; a subtask's story shows in its root's ring; the person can watch it,
send feedback that lands in the agent's chat quoting the frame, and repost it
with a round video to their team; and a person with Stories off sees none of it.
