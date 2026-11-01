# Activity learnings

## Retired status writes must drain without changing activity

Agent status lines were removed at the user's request. Activity now follows only a person's
last message, falling back to conversation creation, and the API retains `statusLine: null`
for released clients. Activity keeps the old `stories.set-status` durable function registered
with its original schema and a no-op executor so interrupted older writes finish safely.
