# Image generation — learnings

## Validation must use the runtime image pipeline

Generated and referenced images are validated and normalized through one bounded processor
contract. Node uses Sharp and the standalone executable uses `Bun.Image`; binary builds must not
embed or load Sharp. Header metadata alone is insufficient validation, so both paths force a full
decode before unmodified source bytes are accepted or a provider PNG is published.
