# Local observability

Run `pnpm observability:up` from any Happy Agent worktree to create or start the shared
local collector and viewers. Running it again safely brings the same stack back
up. Open Grafana at [http://localhost:3000](http://localhost:3000) (default
login: `admin` / `admin`), or Prometheus at
[http://localhost:9090](http://localhost:9090).

The stack has one fixed Docker Compose identity across worktrees. Grafana,
Prometheus, and Tempo retain their data under
`~/Happy/Local/observability/{grafana,prometheus,tempo}`. Containers use an
`unless-stopped` restart policy, so Docker brings them back after daemon or host
restarts unless you explicitly ran `pnpm observability:down`.

Use `pnpm observability:restart` to recreate the running services from the
current worktree's configuration, `pnpm observability:status` to inspect them,
and `pnpm observability:down` to stop and remove the containers without deleting
the retained data.

Happy Agent publishes metrics at `http://127.0.0.1:9464/metrics` and traces to the
collector's OTLP/HTTP endpoint at `http://127.0.0.1:4318/v1/traces`.

Long-lived event streams are excluded by Happy Agent itself because their lifetime does not
describe request latency. Every bounded request and its child spans are retained by
the collector so an `x-rig-trace-id` response header can always be resolved in Tempo.
