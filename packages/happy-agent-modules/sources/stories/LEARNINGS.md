# Stories learnings

## Multipart files keep their declared content type

Bun 1.4.4's native multipart parser replaces file content types with filename inference. It
rejected valid gallery files without an extension and accepted a PNG declared as plain text.
The API imports `undici/index.js` explicitly: Bun substitutes its native parser for bare `undici`.
This uses Undici's multipart parser on both runtimes so binary parts preserve their declared
types before Stories validates the media. Keep the gym cases with extensionless gallery names
and mismatched content types on both Bun and Node.
