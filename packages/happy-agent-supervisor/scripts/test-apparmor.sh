#!/usr/bin/env bash
# Run on Ubuntu with its existing enforced unprivileged_userns profile. This adds confinement;
# it neither loads policy nor changes sysctls. The workload must never be reached.
set -euo pipefail
# Any further arguments come before the policy, such as the `supervisor` subcommand of the single
# happy-agent executable.
binary="${1:?Pass the absolute path of the supervisor binary}"
shift
command -v aa-exec >/dev/null
set +e
output="$(aa-exec -p unprivileged_userns -- "$binary" "$@" \
    --policy '{"mode":"read_only","network":{"egress":false,"localBinding":false}}' \
    -- /bin/sh -c 'echo WORKLOAD_MUST_NOT_RUN' 2>&1)"
status=$?
set -e
if [[ "$status" != 125 || "$output" != *"AppArmor"* || "$output" != *"userns allowance"* || "$output" == *"WORKLOAD_MUST_NOT_RUN"* ]]; then
    printf 'Expected a fail-closed, actionable AppArmor error; exit=%s output=%s\n' "$status" "$output" >&2
    exit 1
fi
printf 'AppArmor denial is actionable; workload did not run.\n'
