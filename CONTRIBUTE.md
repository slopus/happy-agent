# Contributing

Two paths: push access or pull request.

## What we prioritize

Bug fixes that don't add new abstractions. For larger architectural changes,
connect directly and let's discuss as a team: DM [@bra1n_dump](https://x.com/bra1n_dump)
or [@Ex3NDR](https://x.com/Ex3NDR) on X, or email kirill2003de@gmail.com.

## With push permissions

You can validate a change through real installs instead of waiting on a stable
release: publish the affected library packages, cut a preview, and test it on a
nightly Happy Desktop. See [DEVELOPMENT.md](DEVELOPMENT.md#publishing).

## By pull request

Validate end to end before opening the PR: build the agent locally, start it,
and connect Happy Desktop to it ([DEVELOPMENT.md](DEVELOPMENT.md)). Your
feature should work in the real assembly, not just in tests.

The PR body is the main thing another human reads to merge or give feedback.
Keep it very short — no long paragraphs.

- UI change → always include a screenshot.
- Run multiple review rounds before opening: ideally two different providers,
  top-of-the-line models, max reasoning settings. Name the models you used.
- Changing a contract or adding a new abstraction → a human is expected to
  read and approve that code manually; call it out so they know where to look.

### PR body template

````markdown
# Why?

# Design [optional — fold into Change when small]

# Change

```
trigger: <entry point>
|- doThing( { id, doc } ) -> { ok } | { error, reason: 'offline' | 'blocked' }
|- flow: online? --no--> bail, touch nothing
|- ★ + EVENT thing:done { id, ok: bool }    <- new wire contract
```

# Human tested this live

<before / after screenshot or video>

---

Made with <model>, <thinking effort>. Design and final code reviewed by
<models / providers>. Human read the core code: <yes / which parts>.
````

The `# Change` section is a simple ASCII control-flow tree in a code block:
trigger at the root, steps in execution order, signatures at boundaries, real
example payloads. Mark any persisted or wire-contract change with `★` — never
bury one.

`# Human tested this live` is the most important section. Most of the time we
want a before/after screenshot or video of the feature actually working.
