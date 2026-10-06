# Kimi compaction handoff

```text
immutable caller history -> bounded user selection -> preserved users + checkpoint
```

`createKimiCompactedContext` reproduces Kimi Code's user-message selection and summary prefix.
Its ASCII/non-ASCII and media token estimates match the harness. Elision and continuation are
stored as compaction state, so repeated compaction does not mistake them for original user input.
