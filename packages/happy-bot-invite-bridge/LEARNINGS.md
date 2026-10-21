# Invitation bridge decisions

Shared links admit a fixed number of people. The owner preapproves an entire pool of random
guest IDs before sharing the opaque link; each person enters a self-reported name and receives
one private member session. Capacity belongs in private storage, never a link parameter.

A consumed seat is permanent. Revoking, blocking, or expiring a member cannot make that guest
ID available to someone else, because the daemon retains its old conversation and authorship.
Nonce recovery returns the same member even when the invitation is full.

Names are display data, not verified identity or authorization. The daemon places them in a
guest-labeled instruction wrapper as well as UI labels, so the gateway rejects invisible,
control, bidi, tag, and markup content before accepting a name. The first accepted name stays
bound to the member; it never changes routing.
