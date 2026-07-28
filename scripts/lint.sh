#!/usr/bin/env bash

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

status=0

check_text_file() {
  local file=$1

  if ! awk '
    /[ \t]+$/ {
      printf "%s:%d: trailing whitespace\n", FILENAME, FNR
      failed = 1
    }
    length($0) > 100 {
      printf "%s:%d: line is %d characters\n", FILENAME, FNR, length($0)
      failed = 1
    }
    END { exit failed }
  ' "$file"; then
    status=1
  fi

  if [[ -s "$file" ]] && [[ $(tail -c 1 "$file" | wc -l) -eq 0 ]]; then
    printf '%s: missing final newline\n' "$file"
    status=1
  fi
}

while IFS= read -r -d '' file; do
  check_text_file "$file"
done < <(
  find . -type f \
    \( \
      -name '*.json' -o \
      -name '*.md' -o \
      -name '*.mjs' -o \
      -name '*.py' -o \
      -name '*.sh' -o \
      -name '*.toml' -o \
      -name '*.ts' -o \
      -name '*.yaml' -o \
      -name '*.yml' -o \
      -name '.gitignore' -o \
      -name 'LICENSE' -o \
      -path './python/tests/fixtures/bin/*' \
    \) \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './python/.venv/*' \
    -not -path '*/__pycache__/*' \
    -print0
)

while IFS= read -r -d '' file; do
  if ! node --check "$file" >/dev/null; then
    status=1
  fi
done < <(
  find . -type f \
    \( -name '*.mjs' -o -name '*.ts' \) \
    -not -path './node_modules/*' \
    -not -path './python/.venv/*' \
    -print0
)

while IFS= read -r -d '' file; do
  if ! sh -n "$file"; then
    status=1
  fi
done < <(find python/tests/fixtures/bin -type f -print0)

if ! python3 -m compileall -q python/worker.py python/tests; then
  status=1
fi

if ! git diff --check; then
  status=1
fi

if (( status != 0 )); then
  exit "$status"
fi

printf 'Lint checks passed\n'
