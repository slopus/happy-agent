# Master plan 21: happy-agent-modules

## Big picture

This is designed without looking at the existing code. The goal is to define
how features for the Happy agent are written.

One feature instance serves every agent in a collection. That same instance is
also intended for direct use outside the agent system. An API caller, for
example, can set a goal, read it, and perform the feature's other operations.
Those operations are exposed at the top level of the feature itself, not only
as tools for the model. Their methods take `ctx`, the agent ID, and anything
else they need.

A feature's tools and top-level methods may be called concurrently. A feature
must use a local lock of its own when it needs one.

## Events

A feature should usually be able to accept a listener for its events. The
natural shape is two callbacks: `onEventTransactional` runs inside the
transaction that commits the change, and `onEvent` runs outside that
transaction after it has committed. For Goal, events include a goal being set
or cleared. The listener makes those changes available to callers outside the
agent system.

## Durable tools and state

Try to make every tool durable. If a tool is called a second time after a crash
or another interruption, the repeated call should still complete successfully.
Whenever that can be arranged, arrange it and mark the tool durable.

Feature state must live in the `AgentKV` key-value stores passed to the feature.
A feature may use the agent hooks and anything else it needs to implement its
behavior.

## Agent base boundary

Changing `happy-agent-base` is forbidden. If something is genuinely missing
and there is no reasonable way around it, describe the missing change to the
human and ask them to make it in `happy-agent-base`.

## Order and criteria

First give a feature its shared instance and top-level public operations. Then
add its transactional and post-commit events. Make its tools durable wherever
possible and keep its state in the supplied `AgentKV` stores. A feature is done
when all of those applicable parts are available without changing
`happy-agent-base`.
