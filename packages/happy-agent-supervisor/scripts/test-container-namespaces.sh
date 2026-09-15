#!/usr/bin/env bash
# Disposable CI only: prove the denial, then explicitly allow only the test containers.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$(uname -s)" == Linux ]]
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 ]]
container_test_binary="$(pnpm --filter @slopus/happy-agent-compute exec node --input-type=module -e '
import { realpathSync } from "node:fs";
import { resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";
console.log(realpathSync(resolveSupervisorBinary()));
')"
[[ "$container_test_binary" == "$GITHUB_WORKSPACE"/node_modules/*/happy-agent-supervisor ]]
[[ -x "$container_test_binary" ]]

probe_container() {
    docker run --rm --network none \
        --security-opt seccomp=unconfined --security-opt "apparmor=${1:-unconfined}" \
        --security-opt systempaths=unconfined \
        --mount "type=bind,source=$container_test_binary,target=/tools/happy-agent-sandbox,readonly" \
        --entrypoint /tools/happy-agent-sandbox happy-terminal-gym:local \
        --policy '{"mode":"full_access","network":{"egress":true,"localBinding":true}}' \
        -- /bin/sh -c 'printf ready'
}

set +e
container_probe_output="$(probe_container 2>&1)"
container_probe_status=$?
set -e
if [[ "$container_probe_status" != 125 || "$container_probe_output" != *AppArmor* || "$container_probe_output" == *ready* ]]; then
    printf 'Expected the container-path AppArmor denial; exit=%s output=%s\n' "$container_probe_status" "$container_probe_output" >&2
    exit 1
fi
printf 'Confirmed container-path namespace denial: %s\n' "$container_probe_output"

# Docker explicitly selects its container profile; executable-path attachment does not grant
# this allowance. Only containers selecting this named CI profile receive it.
sudo tee /etc/apparmor.d/happy-compute-container-tests >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile happy-compute-container-tests flags=(unconfined) {
    userns,
}
EOF
sudo apparmor_parser --replace /etc/apparmor.d/happy-compute-container-tests
if ! container_probe_output="$(probe_container happy-compute-container-tests 2>&1)"; then
    printf 'Container namespace probe failed with the selected CI profile: %s\n' "$container_probe_output" >&2
    exit 1
fi
[[ "$container_probe_output" == ready ]]
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 ]]
printf 'The same read-only artifact now starts; global namespace restrictions remain enabled.\n'