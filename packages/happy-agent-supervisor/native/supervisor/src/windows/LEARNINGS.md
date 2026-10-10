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

The Untrusted integrity SID has no `UN` SDDL abbreviation. The fixture uses the
explicit `S-1-16-0` SID and verifies its stored authority and RID. An invalid SID
failed the first kernel run before Silo creation; that run provides no BindFlt
availability or filesystem-denial evidence.

The corrected fixture created an owned Silo and installed its read-only BindFlt
mapping on the tested Windows CI host. The exact Silo child read private user and
null-DACL Untrusted files, while parent and sibling writes remained unaffected.
The single absolute private-temp exception still denied its first scratch write.
The probe now uses a separate writable binding on the same owned Silo, following
the HCS shim's writable binding call. The remaining filesystem assertions still
require actual kernel execution; none of the later denial cases ran in that test.
