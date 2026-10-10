# Native title naming

Titles count the first two accepted messages whose actual role is user and whose content contains text. Provenance does not change that rule. The second message snapshots committed History inside acceptance, before a later queued message or model response can appear. Core invokes acceptance hooks for each message and flushes the public history batch separately.

Naming runs after commit in a module-owned lifetime. Requests are serialized per agent and bounded to ten seconds; neither naming nor workspace propagation delays the agent loop. A title chosen before naming completes wins. Refinement is allowed only while the current title matches the exact generated-title provenance in the original shared KV scope.

Initial naming resolves direct workspace placement and then ancestry. One request can produce both the title and workspace slug. Workspace inheritance rechecks whether a person has named the workspace, preserves its numeric prefix and immutable folder identity, and records external Git work as a durable intent after the catalog transaction commits.
