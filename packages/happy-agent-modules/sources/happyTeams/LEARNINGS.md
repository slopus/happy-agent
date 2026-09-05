# Happy teams — learnings

## Administration has two independent authorities

The acting agent identity is captured from module scope. Human-owned root agents may manage the
connected Cloud account, while a direct bot must have `isAdmin`; non-admin bots cannot claim another
bot's identity and receive an error naming the admin bots they can ask. Human subagents do not
receive these tools.

The deployment owner's WorkOS configuration is more sensitive and more specific than general team
management. Expose the user and client IDs through one `get_happy_workos_state` read tool only to an
active admin bot, recheck that bot on execution, and obtain the values from the freshly reverified
Cloud credential and its actual environment-specific client. Do not guess production, add these
identifiers to team-creation inputs or results, or expose the lookup to human roots, ordinary bots,
archived admins, or subagents.

That local check does not replace Happy Cloud authorization. Happy Cloud resolves the connected
WorkOS user and requires active administrator membership in the exact organization before changing
its endpoint. Happy Agent neither accepts a role argument nor caches organization roles.

## Remote team mutations are intentionally not durable

Listing, WorkOS state lookup, creation, and endpoint updates all use CloudModule's serialized token
rotation and token verification boundary. Each operation has its own tool and closed schema.
Creation requires the endpoint, validates it before any remote write, and performs organization
creation followed by the endpoint update with the same minted credential. Those two upstream
operations are not atomic: if only creation succeeds, preserve its team ID in the error and direct
the caller to `update_happy_team`, never another create. Every tool is reviewed because it crosses
the external Happy Cloud boundary. Listing and WorkOS state lookup are durable, reloadable reads;
mutations are non-durable because an interrupted organization creation or metadata write may already
have committed remotely. No local team mirror or retry loop is added.

Happy Cloud may return 10,000 organizations, so the list tool never presents that whole response to
a model. It returns a fixed 10-item page and an exact `next_offset`; the model follows pages until
the offset is null.

## Team provisioning is a standalone control-plane workflow

The existing public organization API continues to return only IDs and names. Agent tools use a
separate internal Happy-team projection with the nullable server endpoint, avoiding an accidental
Happy Agent API change. Team-mode runtimes omit the tools because their one organization is supplied
by deployment configuration rather than the daemon's connected standalone Cloud identity.
