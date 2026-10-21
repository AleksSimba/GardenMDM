#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose config --quiet
docker compose --profile test build tests frontend
docker compose --profile test run --rm tests
