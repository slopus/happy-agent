# Invitation bridge decisions

An invitation is one group chat, not a collection of private bot conversations. The owner
preapproves one random bridge guest ID per invitation. Each person enters a self-reported name
and receives a distinct gateway member and private credential. All members see the full history,
including earlier messages. Capacity belongs in private storage, never a link parameter.

A consumed seat is permanent. Revoking, blocking, or expiring a member cannot make that guest
seat available to someone else. Earlier messages retain their original gateway authorship.
Nonce recovery returns the same member even when the invitation is full.

Names are display data, not verified identity or authorization. Member names must never become
the bridge frame's name or daemon instruction text: that name stays `App Clip group`. Each user
message carries a JSON-quoted untrusted envelope with server-assigned member attribution; body
content cannot forge the outer sender. The gateway also rejects invisible, control, bidi, tag,
and markup content before accepting a name. The first accepted name stays bound to the member;
it never changes routing. `isMine` is derived from stored authorship and the authenticated session.

The existing exported-bot contract supports direct conversations only. The gateway maps each
invitation to one bridge guest and subtask, then owns its member identities and shared transcript.
It must not pretend those members are separate daemon Team guests or add an undocumented group
protocol. Revoke and Leave stop only that member's access and pending sends; the shared guest
and other members continue. Separate invitations have separate bridge guests even on the same bot.
Owner approval confirms the exact shared group bridge ID. Gateway seat IDs are not bridge
identities and never belong on the daemon allowlist; a member count alone cannot confirm approval.
