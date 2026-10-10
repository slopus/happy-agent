#!/usr/bin/env bash
# CI proof for native Rust suites: run one cargo test command, keep its log, and fail unless the
# libtest summaries add up to the expected count with nothing failed or ignored. A green run that
# skipped or filtered away the kernel cases must not read as proof, so the counts are recorded.
#
#   expect-rust-tests.sh <label> exact|min <passed> <log-directory> -- <command>...
set -euo pipefail
label="${1:?Pass a label}"
mode="${2:?Pass exact or min}"
expected="${3:?Pass the expected number of passed tests}"
logs="${4:?Pass the log directory}"
shift 4
[[ "${1:-}" == -- ]] || { printf 'Separate the command with --\n' >&2; exit 2; }
shift
[[ "$mode" == exact || "$mode" == min ]] || { printf 'Mode must be exact or min\n' >&2; exit 2; }
[[ "$expected" =~ ^[0-9]+$ ]] || { printf 'The expected count must be a number\n' >&2; exit 2; }
mkdir -p "$logs"
log="$logs/$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-').log"

set +e
"$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e

passed=0
failed=0
ignored=0
results=0
while IFS= read -r line; do
    [[ "$line" =~ ^test\ result:\ [a-zA-Z]+\.\ ([0-9]+)\ passed\;\ ([0-9]+)\ failed\;\ ([0-9]+)\ ignored\; ]] || continue
    results=$((results + 1))
    passed=$((passed + BASH_REMATCH[1]))
    failed=$((failed + BASH_REMATCH[2]))
    ignored=$((ignored + BASH_REMATCH[3]))
done < "$log"

verdict=pass
reason=""
if [[ "$status" != 0 ]]; then
    verdict=fail
    reason="the command exited with $status"
elif [[ "$results" == 0 ]]; then
    verdict=fail
    reason="no test summary was printed"
elif [[ "$failed" != 0 ]]; then
    verdict=fail
    reason="$failed failed"
elif [[ "$ignored" != 0 ]]; then
    verdict=fail
    reason="$ignored ignored"
elif [[ "$mode" == exact && "$passed" != "$expected" ]]; then
    verdict=fail
    reason="expected exactly $expected passed"
elif [[ "$mode" == min && "$passed" -lt "$expected" ]]; then
    verdict=fail
    reason="expected at least $expected passed"
fi

summary="| $label | $passed passed, $failed failed, $ignored ignored | $mode $expected | $verdict${reason:+ ($reason)} |"
printf '%s\n' "$summary"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY"
fi
[[ "$verdict" == pass ]]
