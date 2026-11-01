# Stories learnings

## Task owners decide whether their agents have story tools

Stories previously followed the last human sender, supported bots, and checked the setting again
inside each tool. They now check only the task owner's setting when assembling the turn's tools;
later messages and setting changes do not revoke tools already assembled. Each bot instead uses
its own Stories switch, off by default, and its originals reach non-guest members with personal
stories on while enabled. A task agent original reaches only its task owner; a person's original
or repost reaches every non-guest team member with stories on.

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
