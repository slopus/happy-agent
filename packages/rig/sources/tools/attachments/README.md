# Attachments

This module prepares pending final-message attachments for the attachment
feature. The session owns `AttachmentContext`: it calls `takePending()` after a
normal terminal response and `discard()` after an abort or error. Completed
attachments survive steering because steering continues the same overall run.

Images are decoded with Sharp and receive dimensions plus a ThumbHash. Rig ships
platform-specific FFmpeg and FFprobe binaries for audio/video metadata and
first-frame extraction; processing runs against Rig's host snapshot, so a
Rig-created Docker environment needs no media tools. Existing containers have
no generated-media mount, so video attachments report that limitation and audio
metadata retains its environment-local fallback. Video previews are persisted
through the host-owned generated-media store. Local attachment metadata exposes
only `generated/...` locators and session-scoped HTTP routes, never host or
container paths. Clients fetch attachment bytes through `downloadUrl` and video
frames through `preview.downloadUrl`; locators are not endpoint-relative URLs.
URL metadata comes from bounded HTML fetches and Open Graph tags.

Secret requests can use the same pending lifecycle for metadata-only
attachments that clients open as masked secret forms. They carry requested
environment variable names and setup guidance, never secret values.
