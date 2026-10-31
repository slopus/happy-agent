# Drive Happy Agent over its REST API

Use this recipe when a script or an agent with only a shell should set up, use, or debug Happy
Agent: find and message agents, create bots, tasks, projects, and workspaces, publish artifacts,
edit Surfaces, and diagnose failures. It is a cookbook of the common calls, one short example per
job. The installed release's `API.md` (in the source checkout, `packages/happy-agent/API.md`) is
the complete contract; each section names the `API.md` section to read for every other field,
status, and rule.

1. [Connect and authenticate](#connect-and-authenticate)
2. [Remote and team daemons](#remote-and-team-daemons)
3. [Configuration, models, and instructions](#configuration-models-and-instructions)
4. [Find bots, tasks, projects, and agents](#find-bots-tasks-projects-and-agents)
5. [Skills and secrets](#skills-and-secrets)
6. [Message an agent and read the reply](#message-an-agent-and-read-the-reply)
7. [Steer, stop, answer, and run commands](#steer-stop-answer-and-run-commands)
8. [Bots](#bots)
9. [Tasks](#tasks)
10. [Projects, workspaces, and agents](#projects-workspaces-and-agents)
11. [Artifacts](#artifacts)
12. [Surfaces: todos, documents, and calendars](#surfaces-todos-documents-and-calendars)
13. [What has no REST route](#what-has-no-rest-route)
14. [Debugging](#debugging)
15. [Pitfalls](#pitfalls)

The examples build on each other in one shell: later ones reuse variables set by earlier ones.
They need `curl`, `jq`, and `openssl`.

## Connect and authenticate

A standalone daemon serves HTTP only on the Unix socket `~/.happy/agent/server.sock`, and every
request except `GET /v0/authentication` needs the bearer token in `~/.happy/agent/token`. Both
live under `$HAPPY_HOME_DIR/agent` when that is set. The token is the daemon's full credential:
never echo, log, or paste it, and keep it out of command arguments. Write it once into a private
header file and use it through these helpers:

```sh
HAPPY_DIR="${HAPPY_HOME_DIR:-$HOME/.happy}/agent"
HAPPY_SOCKET="$HAPPY_DIR/server.sock"
HAPPY_AUTH="$(mktemp)"   # created with mode 0600
trap 'rm -f "$HAPPY_AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$HAPPY_DIR/token")" > "$HAPPY_AUTH"

# happy_api PATH [curl options]: an authenticated request; happy_send METHOD PATH JSON [options].
happy_api() { curl -sS --unix-socket "$HAPPY_SOCKET" -H @"$HAPPY_AUTH" "http://localhost$@"; }
happy_send() {
    local method="$1" path="$2" body="$3"; shift 3
    happy_api "$path" -X "$method" -H 'content-type: application/json' --data-binary "$body" "$@"
}
# A fresh client ID: 24 lowercase letters and digits, valid wherever a request accepts an ID.
new_id() { printf 'm%s' "$(openssl rand -hex 12 | cut -c1-23)"; }

happy_api /v0/health | jq '{ready, version}'
```

Wait until `ready` is `true`; until then only health answers. `version.protocol` is the
compatibility number; see Versioning in `API.md`.

## Remote and team daemons

The local daemon proxies every remote it has configured, standalone or team. List them, then put
`/v0/connections/<id>/api` in front of any path in this recipe:

```sh
happy_api /v0/connections | jq '.connections[] | {id, name, authentication}'
REMOTE=build-mac
happy_api "/v0/connections/$REMOTE/api/v0/health" | jq '{ready, version}'
```

The local daemon supplies the remote's credential, including a team's WorkOS token, so the script
only ever holds the local token. IDs and cursors from a remote belong to it: use them only
through the same prefix. A team daemon reached directly takes an access token for its own
organization, which `POST /v0/cloud/access-token` does not mint; see Authentication and Remote
connections in `API.md`. Remotes are configured in `happy.toml` or by an admin bot, not over HTTP.

## Configuration, models, and instructions

`GET /v0/config` is the sanitized configuration: defaults, the model catalog, providers, MCP
server names, and settings. Credentials never appear in it.

```sh
happy_api /v0/config | jq '.config.defaults'
# Enabled models per provider, with the efforts each accepts.
happy_api /v0/config | jq '.config as $c | $c.providers | to_entries[]
    | select(.value.enabled) | {provider: .key,
      models: [.value.models[] | select(.enabled) | {id, efforts: $c.models[.id].efforts}]}'
```

`PATCH /v0/config` changes the runtime subset: provider `enabled`, node and P2P names, settings,
and voice. `POST /v0/providers/scan` re-detects installed provider credentials. The global agent
instructions are one Markdown document:

```sh
happy_api /v0/config/instructions | jq -r .instructions
happy_send PUT /v0/config/instructions "$(jq -n --arg t "Prefer small commits." '{instructions: $t}')" |
    jq '.instructions | length'
```

`PUT` replaces the whole document, so read it first and send it back edited. See `GET /v0/config`
and `PATCH /v0/config` in `API.md` for the full shapes.

## Find bots, tasks, projects, and agents

There is no global agent list. Every bot and task embeds its one agent as `agent`, and every
project and workspace lists its active top-level agents in `agents`. Lists include archived
entries, so filter on `status`.

```sh
CHIEF_ID=$(happy_api /v0/bots | jq -r '.bots[]
    | select(.systemKey == "chief_of_staff" and .status == "active") | .agent.id')
happy_api /v0/bots | jq '.bots[] | select(.status == "active") | {name, username, agentId: .agent.id}'
happy_api /v0/tasks | jq '.tasks[] | select(.status == "active") | {id, name, agentId: .agent.id}'
happy_api /v0/projects | jq '.projects[] | select(.status == "active")
    | {id, name, path: .compute.path, agents: [.agents[] | {id, title, status}]}'
PROJECT_ID=$(happy_api /v0/projects | jq -r '[.projects[] | select(.status == "active")][0].id')
happy_api "/v0/workspaces?projectId=$PROJECT_ID" |
    jq '.workspaces[] | {id, name, branch: .git.branch, agents: [.agents[].id]}'
```

`GET /v0/bootstrap/desktop` returns config, projects, root and first-level workspaces, bots,
tasks, Surfaces, and recently archived agents in one response, with a `cursor` to follow events
from. One agent, with its subtasks and status:

```sh
AGENT_ID=$CHIEF_ID
happy_api "/v0/agents/$AGENT_ID" |
    jq '.agent | {title, status, canSendMessages, pendingQuestionId, subtasks: [.subtasks[].id]}'
```

Bot and task workspaces never appear in `/v0/workspaces`; reach them through their bot or task.

## Skills and secrets

Global skills come from `~/.agents/skills`. The API lists, reads, and enables them; installing a
skill means writing its folder.

```sh
happy_api '/v0/skills?limit=100' | jq '.skills[] | {id, name, enabled, status}'
SKILL=$(happy_api '/v0/skills?limit=100' | jq -c '.skills[0]')
happy_send PATCH "/v0/skills/$(jq -r .id <<<"$SKILL")" '{"enabled": false}' \
    -H "If-Match: $(jq -r .version <<<"$SKILL")" | jq '.skill | {name, enabled}'
```

Secrets are named environment bundles. Values are write-only: no response ever returns them, so
read safe metadata and attach secrets to a project, workspace, or exact agent. An attachment only
makes a secret eligible; a command still names the secrets it uses.

```sh
happy_api /v0/secrets | jq '.secrets[] | {id, description, environmentVariables, availableToAgents}'
SECRET_ID=deploy_api
happy_send PUT "/v0/secrets/$SECRET_ID/attachments/project/$PROJECT_ID" '{}' | jq '{created}'
happy_api "/v0/secrets/$SECRET_ID/attachments" | jq '.attachments[] | .target'
happy_send DELETE "/v0/secrets/$SECRET_ID/attachments/project/$PROJECT_ID" '{}' | jq '{detached}'
```

Creating a secret (`POST /v0/secrets`) puts its value in the request body; build that body from a
file or variable, never from a literal in a command or a transcript. See Global skills and
Secrets in `API.md`.

## Message an agent and read the reply

A send needs `text`, a complete `mode`, and your own `id`. Copy the agent's last mode; an agent
that has never had a message returns `null`, so fall back to the configured defaults:

```sh
MODE=$(happy_api "/v0/agents/$AGENT_ID/mode" | jq -c .mode)
[ "$MODE" = null ] && MODE=$(happy_api /v0/config | jq -c '.config.defaults + {serviceTier: null}')

MSG_ID=$(new_id)
happy_send POST "/v0/agents/$AGENT_ID/send" "$(jq -n --arg id "$MSG_ID" --argjson mode "$MODE" \
    --arg text "Summarize the open work in three bullets." '{id: $id, text: $text, mode: $mode}')" |
    jq '{id: .message.id, status: .message.status, cursor}'
```

The answer is `202` once the message is durable. Sending the same `id` again never sends twice, so
retry a lost response with it. To read the reply, poll history until the run holding your message
has finished, then print the agent's text. Give the loop a deadline in real scripts:

```sh
until RUN=$(happy_api "/v0/agents/$AGENT_ID/messages?omitToolData=true" | jq -e --arg m "$MSG_ID" \
    '.runs[] | select(any(.messages[]; .id == $m)) | select(.status != "running")'); do
    sleep 3
done
jq '{status, reason}' <<<"$RUN"
jq -r '.messages[] | select(.role == "agent") | .content[] | select(.type == "text") | .text' <<<"$RUN"
```

A run ends `completed`, `aborted`, or `failed`. History is grouped by run, newest runs last;
`before=<runId>` pages back. A queued message is absent from history until a run accepts it; the
agent's `GET /v0/agents/:agentId/bootstrap` lists it under `pending`.

To watch live instead, follow the event stream. Each frame's `event:` is the type, such as
`run.started`, `message.delta` (streamed text), `message.updated`, or `run.finished`:

```sh
CURSOR=$(happy_api "/v0/agents/$AGENT_ID/bootstrap" | jq -r .cursor)
happy_api "/v0/events/stream?after=$CURSOR" -N --max-time 30 | grep --line-buffered '^event:'
```

`--max-time` ends the stream, so curl reports a timeout (exit 28) when it does.
`GET /v0/events?after=<cursor>` pulls the same journal page by page. See Messages and runs,
`send`, and Events in `API.md`.

## Steer, stop, answer, and run commands

`delivery: "steer"` puts a message in front at the next safe boundary instead of waiting for the
current run; on an idle agent it is the same as the default `"queue"`:

```sh
happy_send POST "/v0/agents/$AGENT_ID/send" "$(jq -n --arg id "$(new_id)" --argjson mode "$MODE" \
    '{id: $id, text: "Stop after the first bullet.", delivery: "steer", mode: $mode}')" | jq .message.status
```

Stop the current run, its subagents, and its background processes. `expectedRunId` is optional and
makes the abort `409` if a different run has started since:

```sh
happy_send POST "/v0/agents/$AGENT_ID/abort" '{}' | jq '.agent.status'
```

When `pendingQuestionId` is set, the run waits for a person. Read the question and answer each
of its prompts by ID with option labels or free text:

```sh
Q=$(happy_api "/v0/agents/$AGENT_ID/question" | jq -c .question)
jq '{id, context, questions: [.questions[] | {id, question, options: [.options[].label]}]}' <<<"$Q"
happy_send POST "/v0/agents/$AGENT_ID/question/$(jq -r .id <<<"$Q")/answer" \
    "$(jq -c '{answers: {(.questions[0].id): [.questions[0].options[0].label]}}' <<<"$Q")" |
    jq .question.status
```

Slash commands are listed on the agent and invoked with the same `mode` as a send. `compact`
summarizes older context and is allowed only while the agent is idle:

```sh
happy_api "/v0/agents/$AGENT_ID" | jq '.slashCommands[] | {name, hasArguments, kind}'
happy_send POST "/v0/agents/$AGENT_ID/slash-commands/compact" "$(jq -n --argjson mode "$MODE" '{mode: $mode}')" |
    jq '.command.name'
```

See Questions, `abort`, `compact`, and Slash commands in `API.md`.

## Bots

A bot is one long-lived conversation with its own folder. Creating it creates its workspace and
agent; the response is ready for a first message. Bot changes need `If-Match` with the bot's
`version`.

```sh
BOT=$(happy_send POST /v0/bots "$(jq -n --arg id "$(new_id)" \
    '{id: $id, name: "Research Assistant", username: "research_assistant"}')" | jq -c .bot)
BOT_ID=$(jq -r .id <<<"$BOT"); BOT_AGENT_ID=$(jq -r .agent.id <<<"$BOT")
BOT_VERSION=$(happy_send PATCH "/v0/bots/$BOT_ID" '{"name": "Researcher"}' \
    -H "If-Match: $(jq -r .version <<<"$BOT")" | jq -r .bot.version)
happy_send POST "/v0/bots/$BOT_ID/archive" '{}' -H "If-Match: $BOT_VERSION" | jq '.bot.status'
```

Message a bot through its `agent.id` exactly as above. Omitting `name` creates `New Bot`, which
names itself from its first message. Archive and unarchive go through the bot, never its agent.
See Bots in `API.md`.

## Tasks

A task is a bot-like conversation for one piece of work, with its own folder. It is created
idle; give it its work, model, and permission mode with a first send:

```sh
TASK=$(happy_send POST /v0/tasks "$(jq -n --arg id "$(new_id)" '{id: $id, name: "Fix login redirect"}')" |
    jq -c .task)
TASK_ID=$(jq -r .id <<<"$TASK"); TASK_AGENT_ID=$(jq -r .agent.id <<<"$TASK")
TASK_MODE=$(happy_api /v0/config | jq -c '.config.defaults + {serviceTier: null}')
happy_send POST "/v0/agents/$TASK_AGENT_ID/send" "$(jq -n --arg id "$(new_id)" --argjson mode "$TASK_MODE" \
    '{id: $id, text: "Find why login redirects loop and propose a fix.", mode: $mode}')" | jq .message.status
```

Rename, archive, and unarchive need `If-Match` with the task's `version`. Reorder moves the task
in your own list and needs none:

```sh
TASK_VERSION=$(happy_send PATCH "/v0/tasks/$TASK_ID" '{"name": "Fix the login loop"}' \
    -H "If-Match: $(jq -r .version <<<"$TASK")" | jq -r .task.version)
happy_send POST "/v0/tasks/$TASK_ID/reorder" '{"afterId": null}' | jq '.membership.orderKey'
happy_send POST "/v0/tasks/$TASK_ID/archive" '{}' -H "If-Match: $TASK_VERSION" | jq '.task.status'
```

`GET /v0/tasks?scope=joined` lists only your own tasks in your order. Subtasks have no creation
route: an agent creates them with its `create_subtask` tool, so ask a bot or task to delegate.
Once created, a subtask appears in its parent's `subtasks` and takes messages like any agent. See
Tasks in `API.md`.

## Projects, workspaces, and agents

Register an existing folder, or clone a plain HTTPS repository into managed storage:

```sh
PROJECT_PATH="$HOME/Developer/my-app"
NEW_PROJECT=$(happy_send POST /v0/projects "$(jq -n --arg p "$PROJECT_PATH" '{path: $p}')" | jq -c .project)
jq '{id, name, init: .initialization.status}' <<<"$NEW_PROJECT"
happy_send POST /v0/projects/clone '{"name": "rig", "source": {"kind": "github", "repository": "slopus/rig"}}' |
    jq '.project | {id, init: .initialization.status}'
```

Both set up in the background: wait for `initialization.status` to leave `"initializing"`. A
workspace is a Git worktree on its own branch under a parent workspace; a project's ID is also its
root workspace's ID. Create one, start an agent in it, then rename or archive the workspace with
`If-Match`:

```sh
WS_ID=$(happy_send POST /v0/workspaces "$(jq -n --arg p "$PROJECT_ID" --arg id "$(new_id)" \
    '{id: $id, parentId: $p, name: "fix-login"}')" | jq -r .workspace.id)
NEW_AGENT_ID=$(happy_send POST /v0/agents "$(jq -n --arg w "$WS_ID" --arg id "$(new_id)" \
    '{id: $id, workspaceId: $w, title: "Fix the login loop"}')" | jq -r .agent.id)
WS_VERSION=$(happy_api "/v0/workspaces/$WS_ID" | jq -r .workspace.version)
WS_VERSION=$(happy_send PATCH "/v0/workspaces/$WS_ID" '{"name": "fix-login-v2"}' \
    -H "If-Match: $WS_VERSION" | jq -r .workspace.version)
happy_send POST "/v0/workspaces/$WS_ID/archive" '{}' -H "If-Match: $WS_VERSION" | jq '.workspace.status'
```

The workspace answers at once and builds its checkout in the background; its agent can be
messaged when `initialization.status` is `"ready"`. Archiving a workspace stops every agent in
it. An agent is archived or restored on its own with `POST /v0/agents/:agentId/archive` and
`/unarchive`. A project is archived with `POST /v0/projects/:projectId/archive` and `If-Match`;
an archived project comes back by registering its path again. See Projects and workspaces,
Workspaces, and Agents in `API.md`.

## Artifacts

Artifacts are published documents, pages, images, and files, each version immutable. Agents
usually publish them with their artifact tools; people and scripts use these routes.

```sh
happy_api '/v0/artifacts?limit=20' | jq '.artifacts[] | {id, type, title, latestVersion}'
ART=$(happy_send POST /v0/artifacts "$(jq -n --arg id "$(new_id)" '{id: $id, type: "markdown",
    title: "Status report", files: [{path: "index.md", text: "# Status\n\nAll green.\n"}]}')" | jq -c .artifact)
ART_ID=$(jq -r .id <<<"$ART")
happy_api "/v0/artifacts/$ART_ID/versions/latest/files/index.md"
ART_VERSION=$(happy_send PATCH "/v0/artifacts/$ART_ID" \
    '{"files": [{"path": "index.md", "text": "# Status\n\nOne failing test.\n"}]}' \
    -H "If-Match: $(jq -r .version <<<"$ART")" | jq -r .artifact.version)
happy_send POST "/v0/artifacts/$ART_ID/delete" '{}' -H "If-Match: $ART_VERSION" | jq .artifact.status
```

Binary files go up first with `POST /v0/artifact-uploads` (raw bytes) and are then placed with
`{ "path": ..., "uploadId": ... }`. An update starts from the latest version's files; `remove`
and `replaceAll` take files out. See Artifacts in `API.md` for types, limits, and sources.

## Surfaces: todos, documents, and calendars

Surfaces are shared lists, documents, and calendars. Their IDs are exactly 24 characters, a
lowercase letter then letters or digits, which `new_id` produces.

```sh
happy_api /v0/surfaces | jq '.surfaces[] | {id, type, name}'
LIST_ID=$(happy_send POST /v0/surfaces "$(jq -n --arg id "$(new_id)" \
    '{id: $id, type: "todo", name: "Release checklist"}')" | jq -r .surface.id)
TODO=$(happy_send POST "/v0/surfaces/todo/$LIST_ID" "$(jq -n --arg id "$(new_id)" \
    '{id: $id, text: "Tag the release"}')" | jq -c .todo)
happy_send PATCH "/v0/surfaces/todo/$LIST_ID/$(jq -r .id <<<"$TODO")" '{"status": "completed"}' \
    -H "If-Match: $(jq -r .version <<<"$TODO")" | jq '.todo | {text, status}'
happy_api "/v0/surfaces/todo/$LIST_ID?scope=all" | jq '.todos[] | {text, status}'
```

Every change to an existing todo, including reorder and `DELETE`, needs its current `version` in
`If-Match`. Documents are created with Markdown and read back as Markdown; live editing uses
collaborative updates, so ask an agent with document tools to change one:

```sh
DOC_ID=$(happy_send POST /v0/surfaces "$(jq -n --arg id "$(new_id)" \
    '{id: $id, type: "document", name: "Notes", text: "# Notes\n\nFirst entry.\n"}')" | jq -r .surface.id)
happy_api "/v0/surfaces/document/$DOC_ID" | jq -r .document.text
```

Calendars hold timed or all-day events. Reading takes an instant range and the viewer's time
zone; changing an event needs `If-Match`:

```sh
CAL_ID=$(happy_send POST /v0/surfaces "$(jq -n --arg id "$(new_id)" \
    '{id: $id, type: "calendar", name: "Team"}')" | jq -r .surface.id)
EVENT=$(happy_send POST "/v0/surfaces/calendar/$CAL_ID" '{"title": "Release review",
    "timing": {"kind": "allDay", "startDate": "2026-11-02", "endDate": "2026-11-03"}}' | jq -c .event)
happy_send PATCH "/v0/surfaces/calendar/$CAL_ID/$(jq -r .id <<<"$EVENT")" '{"location": "Room 4"}' \
    -H "If-Match: $(jq -r .version <<<"$EVENT")" | jq '.event | {title, location}'
happy_api "/v0/surfaces/calendar/$CAL_ID?from=1793491200000&to=1796083200000&timeZone=UTC" |
    jq '.occurrences[] | {eventId, timing}'
```

There is no Surface deletion; `POST /v0/surfaces/:surfaceId/leave` removes one from your sidebar.
See Surfaces, Document Surfaces, and Calendar Surfaces in `API.md`.

## What has no REST route

Some things agents do have no HTTP route. Ask an agent to do them in a message instead, usually
the Chief of Staff:

- scheduling messages, durable waits, and multi-agent workflows;
- creating subtasks, and messaging between agents;
- editing document Surfaces and artifact files in place;
- reading an HTML artifact app's error reports (`read_artifact_logs`).

MCP servers are configured in files, as the bundled `MCP.md` describes, and remote connections
in machine `happy.toml` (Remote connections in `API.md`).

## Debugging

- **Is it up, and which version?** `GET /v0/health` reports `ready`, `version`, and, while
  stopping, `draining` and `shuttingDown`. A draining daemon still reads but answers mutations
  `503 draining`.
- **Is my token right?** `GET /v0/authentication` needs no token and says whether the one you
  sent is valid: `happy_api /v0/authentication | jq .authenticated`.
- **What is the agent doing?** `status` on `GET /v0/agents/:agentId` is `idle`, `thinking`,
  `working`, `generating_tools`, or `running_tools`. `retrying` shows automatic provider
  recovery, `pendingQuestionId` a wait on a person, and `wait` a scheduled wait.
- **Why did a run fail?** Read the latest run with tool data. Failed tool calls show their
  `status`, and an error `service` message carries a typed `failure`:

```sh
happy_api "/v0/agents/$AGENT_ID/messages?limit=10" | jq '.runs[-1] | {status, reason, messages:
    [.messages[] | {role, failure: .failure.kind, blocks: [.content[] | {type, name, status}]}]}'
```

- **What did it start?** `GET /v0/agents/:agentId/activity` lists every subagent and background
  process it spawned, with their states.
- **How much did it use?** `GET /v0/agents/:agentId/usage` gives tokens by provider and model and
  the current context size; `GET /v0/usage` gives installation-wide windows and provider account
  readings. Each run in history also carries `usage`, `costUsd`, `startedAt`, and `endedAt`.
- **Did I miss events?** A stream's `hello` frame with `"gap": true`, or `409 cursor_unavailable`
  from `/v0/events`, means the cursor fell out of the bounded journal. Re-read the snapshots you
  rely on, then continue from the cursor the daemon returned.
- **Errors** are `{ "error": "...", "code": "..." }`. Branch on `code`: `invalid_request` (400),
  `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409: stale `If-Match`
  or wrong state), `draining` and `remote_unavailable` (503). A stale `If-Match` answer carries
  `currentVersion` and the current resource, so retry with that version.

Full details are under Errors, `GET /v0/health`, Events, and Typed failures in `API.md`.

## Pitfalls

- **`mode` is required.** Copy it from `/mode` or the config defaults; an unknown or disabled
  model, effort, or service tier is `400`.
- **Retry with the same `id`.** Sends and the creation of bots, tasks, agents, artifacts,
  Surfaces, todos, and events return the original instead of making a second one. IDs are
  lowercase letters and digits starting with a letter; UUIDs are rejected.
- **`409` on send means the agent can't receive messages:** it is a hidden subagent or archived.
- **Send the version you last read.** Projects, workspaces, bots, tasks, artifacts, secrets,
  todos, calendar events, and the profile need `If-Match`; agents and sends do not.
- **The event journal is bounded.** After a gap, re-read snapshots instead of assuming nothing
  happened.
- **Branch on `code`, not `error`.** `error` is display text and may change.
- **Archive, don't delete,** and don't test on real agents: follow
  [Testing a deployed node](README.md#testing-a-deployed-node).
