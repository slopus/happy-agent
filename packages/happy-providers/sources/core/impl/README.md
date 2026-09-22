# Credential refresh support

`credentialRefresh.ts` supplies process-local single-flight execution keyed by canonical auth
file path, bounded HTTP work and response parsing, and cancellable observers. Each vendor owns
its refresh request, credential validation, and persistence.

```text
maintenance / inference recovery
             |
     canonical-file single flight
             |
  bounded vendor exchange -> persist rotated login
```

Only pending work is retained. Cancelling one observer does not cancel an exchange that another
session shares or prevent its rotated token from being saved. This is not a cross-process lock.
