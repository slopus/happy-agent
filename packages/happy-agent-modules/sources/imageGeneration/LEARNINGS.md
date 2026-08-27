# Image generation — learnings

## No Codex account means no tool

The image tool used to be offered to every model unconditionally, so an installation with only
non-Codex accounts (for example, Bedrock only) received a tool whose every call failed with "No
Codex account is configured". The tools hook now returns nothing when no enabled Codex account
exists, because a capability with nothing behind it should be absent rather than broken.

## Validation must use the runtime image pipeline

Generated and referenced images are validated and normalized through one bounded processor
contract. Node uses Sharp and the standalone executable uses `Bun.Image`; binary builds must not
embed or load Sharp. Header metadata alone is insufficient validation, so both paths force a full
decode before unmodified source bytes are accepted or a provider PNG is published.

## Virtual model routes are not direct image accounts

A smart provider may have Codex compatibility so its agents can share Codex model context, but it
is a model-session router rather than a `CodexProvider` with the image API. Image-account discovery
therefore excludes smart providers and counts only enabled concrete Codex accounts.
