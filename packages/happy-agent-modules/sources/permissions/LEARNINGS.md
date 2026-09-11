# Permissions module learnings

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
