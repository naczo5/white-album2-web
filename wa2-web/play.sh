#!/bin/sh
# One-command launcher. See docs/ONECLICK.md.
set -eu
cd "$(dirname "$0")"
exec python3 tools/oneclick.py "$@"
