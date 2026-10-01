#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${GS_DATABASE}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  printf 'Invalid database name: %s\n' "${GS_DATABASE}" >&2
  exit 1
fi

export LD_LIBRARY_PATH=/usr/local/opengauss/lib

GSQL=(
  /usr/local/opengauss/bin/gsql
  -h "${GS_HOST}"
  -p "${GS_PORT}"
  -U "${GS_USERNAME}"
  -W "${GS_PASSWORD}"
  -v ON_ERROR_STOP=1
)

if [[ "$("${GSQL[@]}" -d postgres -t -A -c "SELECT COUNT(*) FROM pg_database WHERE datname = '${GS_DATABASE}'")" == "0" ]]; then
  "${GSQL[@]}" -d postgres -c "CREATE DATABASE ${GS_DATABASE}"
fi

"${GSQL[@]}" -d "${GS_DATABASE}" -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)"

for sql_file in /docker/init/*.sql; do
  version="$(basename "${sql_file}")"
  applied="$("${GSQL[@]}" -d "${GS_DATABASE}" -t -A -c "SELECT COUNT(*) FROM schema_migrations WHERE version = '${version}'")"
  if [[ "${applied}" == "0" ]]; then
    "${GSQL[@]}" -d "${GS_DATABASE}" -f "${sql_file}"
    "${GSQL[@]}" -d "${GS_DATABASE}" -c "INSERT INTO schema_migrations (version) VALUES ('${version}')"
  fi
done
