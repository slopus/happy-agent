# Node search

One search over everything in the node the caller may see, served as `POST /v0/search` (see
"Search" in `packages/happy-agent/API.md`). Each module that owns a kind of thing ranks its own
matches; this module asks every provider the request's `types` select at once and fuses their
lists with Reciprocal Rank Fusion, k = 60, equal scores in a fixed provider order and then by
position. It is `NodeSearchModule` because `SearchModule` is the web search tool.

```ts
const nodeSearch = new NodeSearchModule(
    surfaces,
    artifacts,
    history,
    projects,
    workspaces,
    tasks,
    bots,
    subtasks,
    team,
    globalSkills,
);
```

| Module               | Why                                                                   |
| -------------------- | --------------------------------------------------------------------- |
| `SurfacesModule`     | Vault items, documents, todos, calendar events, and Surface names     |
| `ArtifactsModule`    | Artifact titles, summaries, and text                                  |
| `HistoryModule`      | The messages people and agents wrote                                  |
| `ProjectsModule`     | Project names, and the conversations attached to each project         |
| `WorkspacesModule`   | Workspace names, and the conversations attached to each workspace     |
| `TasksModule`        | Task conversations, and which tasks the caller has joined             |
| `BotsModule`         | Bot conversations, found by name and username                         |
| `SubtasksModule`     | Which child agents are subtasks people see rather than hidden helpers |
| `TeamModule`         | Team members by name or email, in team mode only                      |
| `GlobalSkillsModule` | Global skills by name or description                                  |

Providers answer within a 250 ms budget; one that fails or is late is left out and the answer is
marked `partial`. Conversations come from an in-memory catalog of at most 20,000 agents people
see, titled or not, rebuilt in the background at most every five seconds, so a search never waits
on more than the first build. Bots and tasks go by their own names, other conversations by their
titles, and untitled ones are found only through their messages. The same catalog decides whose
messages a caller may find: every conversation, but a task and its subtasks only for its members.
