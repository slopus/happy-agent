#!/usr/bin/env bash
# Run TLC on every configuration in this directory (or on the ones named as arguments).
#
#   ./run.sh                      # all configurations
#   ./run.sh Safety LivenessAbort # selected configurations
#
# SingleOwner*.cfg check SingleOwner.tla; every other configuration checks AgentBase.tla.
# SingleOwnerResolveGap.cfg is EXPECTED to report a violation: it shows why a stated assumption is
# needed (see README.md). Every other configuration is expected to pass; one that does not is a
# defect in the code (or the model). The script exits non-zero when any
# configuration's outcome differs from its expectation.
#
# Environment:
#   TLA2TOOLS  path to tla2tools.jar (default: /opt/tlaplus-1.7.4/tla2tools.jar, else ./tla2tools.jar)
#   TLC_OUT    directory for logs, state files and Java temp files
#              (default: <repo>/.context/tla-out, which is gitignored)
#   TLC_HEAP   JVM heap (default: 3g)
#   TLC_WORKERS number of TLC workers (default: auto)
#
# TLC exports its fingerprint set over RMI at startup, so it needs to bind a local socket.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null || echo "$here")"
jar="${TLA2TOOLS:-}"
if [[ -z "$jar" ]]; then
    if [[ -f /opt/tlaplus-1.7.4/tla2tools.jar ]]; then jar=/opt/tlaplus-1.7.4/tla2tools.jar
    else jar="$here/tla2tools.jar"; fi
fi
[[ -f "$jar" ]] || { echo "tla2tools.jar not found; set TLA2TOOLS" >&2; exit 2; }
out="${TLC_OUT:-$repo/.context/tla-out}"
mkdir -p "$out/tmp"

if [[ $# -gt 0 ]]; then configs=("$@"); else
    configs=()
    for f in "$here"/*.cfg; do configs+=("$(basename "$f" .cfg)"); done
fi

status=0
for name in "${configs[@]}"; do
    log="$out/$name.log"
    module=AgentBase
    [[ "$name" == SingleOwner* ]] && module=SingleOwner
    printf '%-32s ' "$name"
    start=$(date +%s)
    ( cd "$here" && java -XX:+UseParallelGC "-Xmx${TLC_HEAP:-3g}" "-Djava.io.tmpdir=$out/tmp" \
        -cp "$jar" tlc2.TLC -nowarning -cleanup -workers "${TLC_WORKERS:-auto}" \
        -metadir "$out/meta-$name" -config "$name.cfg" "$module.tla" ) >"$log" 2>&1 || true
    secs=$(( $(date +%s) - start ))
    counts=$(grep -E '^[0-9,]+ states generated' "$log" | tail -1 | sed -E 's/ states left on queue\.//')
    if grep -q "Model checking completed. No error has been found." "$log"; then
        outcome=pass
    elif grep -qE "is violated|Temporal properties were violated" "$log"; then
        outcome=violated
    else
        outcome=error
    fi
    expected=pass
    [[ "$name" == SingleOwnerResolveGap ]] && expected=violated
    verdict=OK
    [[ "$outcome" == "$expected" ]] || { verdict=UNEXPECTED; status=1; }
    printf '%-9s (expected %-8s) %-10s %5ss  %s\n' "$outcome" "$expected" "$verdict" "$secs" "$counts"
done
echo "Logs and counterexample traces: $out"
exit $status
