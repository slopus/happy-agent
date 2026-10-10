# Native credential learnings

Grok's stored API key precedes its stored OAuth session. The first native loader
selected the session first and could charge a different account. Discovery now
uses the shipped credential order; a deterministic two-record fixture verifies
the actual authorization header.
