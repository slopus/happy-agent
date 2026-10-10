# Windows kernel boundary learnings

A restricting SID list containing Everyone does not deny Everyone-writable files.
The real kernel counterexample opens and changes such a file with the Source token pattern.

Keeping only an unused restricting SID with `WRITE_RESTRICTED` preserves private user reads
and denies data writes and `WRITE_DAC` on user and Everyone ACLs. A real null-DACL file still
permits both operations. These are facts about the tested token patterns; Read only admission
remains closed while a complete filesystem, sensitive-read, network and handle boundary is missing.

The unused SID is a synthetic `S-1-5-21` restrictor. The test does not create an AppContainer;
reports must identify the token and restricting SIDs actually exercised.

A path-only write check misses aliases and inherited writable handles. The test-only owned
Silo experiment also exercises volume GUID and NT aliases, hardlinks, owner DACL changes,
and exclusion of an inheritable writable file handle. It requires private reads and writable
private temporary storage, while parent and sibling writes remain unaffected. Missing APIs or
failed Silo setup fail the kernel test; they are never a passing skip. This remains a filesystem
experiment and does not establish a complete Read only boundary.
