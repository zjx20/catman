#!/bin/sh
set -eu
# SSH 通常切到用户 HOME；显式恢复 Docker -w 指定的共享 workspace。
IFS= read -r ops_workspace < /run/catman-ops-workspace
cd "$ops_workspace"
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"
fi
exec /bin/bash -i
