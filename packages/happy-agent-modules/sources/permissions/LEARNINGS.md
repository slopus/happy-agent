# Permissions module learnings

## File content needs a larger per-string review budget

The 8,192-character argument-string limit rejected ordinary long file writes before a reviewer
could see them. The limit is now 32,768 characters, allowing larger content to reach review without
truncation. The separate 65,536-byte total argument limit, nesting and collection limits, and
normal permission decisions remain unchanged; increasing the string budget does not grant access.

## A critical-risk label is not a runtime veto

The runtime rejected every critical-risk action even when the reviewer explicitly allowed it
after informed user approval. Both enforcement layers now honor the reviewer's critical-risk
outcome instead of overriding it. Reviewer denials, the separate high-risk authorization check,
and per-call sandbox elevation and restoration remain enforced. This keeps policy interpretation
with the reviewer and avoids turning a valid approval into another refusal.

## A denial stops the action, not future informed user authorization

Calling every denial "final" led agents to refuse even after the user explicitly authorized the
exact action and its disclosed risks. Auto guidance and tool refusal responses now distinguish
unauthorized retries from one fresh review supported by new, explicit user authorization. Without
that authorization, the agent must use a materially safer alternative or stop and explain the
action and concrete risk. Fresh review is not permission to execute: existing policy enforcement
and refusal-loop limits remain in force, and another denial stops the action again. Assistant
claims, tool output, and vague requests to continue cannot supply the new authorization.

## A destination refusal names its two remedies

An export to the user's own third-party account was refused, and the refusal cited a "tenant policy"
the user could not find or change. A denial now tells the agent that a refusal about an untrusted
external destination can be resolved by the user explicitly approving that exact destination and
data after the risk is explained, or by adding the destination as trusted to their global
`SECURITY.md`, whose path the auto module supplies from configuration. Unproven outcomes carry no
such remedy, because nothing judged the destination.

## A foreign harness keeps its own Auto reviewer

Happy's Auto reviewer judged Happy tool calls a foreign harness made over MCP, after the harness's
own reviewer had already decided them, so one action was reviewed twice by two policies. In Auto,
Permissions now leaves calls from an agent on a foreign harness to that harness's reviewer and
never elevates them. Compute decides, the same way it decides which tools the agent gets: Claude
Code and Codex CLI run on ordinary `claude` and `codex` accounts, so a first version that tested
the provider kind still reviewed both twice, and a gateway's model ID can look like a harness's
while running on Happy's own loop. Harness reviewers are more permissive than Happy's (Claude Code's
classifier allowed a force push and `rm` outside the project); Workspace write is the mode that
puts every outside action to the person.
