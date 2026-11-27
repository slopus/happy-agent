# Node search learnings

## One long conversation must not take every message result

Message results were the best matches in BM25 order with nothing per conversation, so a long
conversation that kept repeating the query filled every message place, even at `limit: 100`, and
the desktop palette, which shows one row per conversation, could only ever reach that one. Search
now takes at most three messages from each conversation, its best, inside the message provider's
scan, and each message result carries `agentMatchCount` so a client can say how many more that
conversation holds. The cap is the default, not a request field, because the published client's
request schema is strict and older daemons reject fields they do not know.

## Subtask results name their parent

Clients dropped subtask results because they could not tell which conversation to put them under.
The conversation catalog already walks from each conversation to its subtasks, so it records the
parent, and `agent` and `message` results report it as `parentAgentId`, the same value
`GET /v0/agents` gives. Hidden subagents stay out of the catalog, so they are still never found.
