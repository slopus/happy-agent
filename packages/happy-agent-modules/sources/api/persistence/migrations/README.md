# API migrations

Immutable asynchronous schema history owned by the API module:

```text
001-team-drafts → one current draft per agent and team user
```

Add subsequent schema changes as new migrations; never rewrite a released migration.
