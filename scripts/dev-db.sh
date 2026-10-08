#!/usr/bin/env sh
# Starts the development Postgres (port 5433). Production uses the real
# server's DATABASE_URL instead. Works with podman or docker.
set -eu
runtime=$(command -v podman || command -v docker)
if "$runtime" container inspect mpf-pos-db >/dev/null 2>&1; then
  "$runtime" start mpf-pos-db >/dev/null
else
  "$runtime" run -d --name mpf-pos-db \
    -e POSTGRES_USER=mpf -e POSTGRES_PASSWORD=mpf -e POSTGRES_DB=mpf \
    -p 5433:5432 -v mpf-pos-db:/var/lib/postgresql/data \
    docker.io/library/postgres:17-alpine >/dev/null
fi
until "$runtime" exec mpf-pos-db pg_isready -U mpf -q; do sleep 0.5; done
echo "Postgres ready at postgres://mpf:mpf@localhost:5433/mpf"
