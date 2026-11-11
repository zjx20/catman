#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=${CLAUDE_CONFIG_DIR:?}/skills/wechat-article
case "${1:-}" in
  draft|update)
    ARTICLE=${2:?需要 article.json 路径}
    KEY=
    PREVIOUS=
    for ARG in "$@"; do
      [ "$PREVIOUS" != --job-key ] || KEY=$ARG
      PREVIOUS=$ARG
    done
    [ "$PREVIOUS" != --job-key ] || { printf '%s\n' '缺少 --job-key 的值' >&2; exit 2; }
    node "$ROOT/package.mjs" check --article "$ARTICLE" --cover "$ROOT/assets/cover.png" --job-key "${KEY:-draft}"
    "$SKILL_DIR/scripts/publish.sh" render "$ARTICLE" --output "$(dirname -- "$ARTICLE")/preview.html" >&2
    RESULT=$("$SKILL_DIR/scripts/publish.sh" "$@")
    set -- pack --article "$ARTICLE" --root "${CATMAN_USER_PRIVATE_DIR:-/user}/artifacts/wechat-daily" --result "$RESULT" --cover "$ROOT/assets/cover.png"
    [ -z "$KEY" ] || set -- "$@" --job-key "$KEY"
    if ! node "$ROOT/package.mjs" "$@" >&2; then
      printf '%s\n' "$RESULT"
      printf '%s\n' '微信草稿操作已成功，但本地归档失败。请仅修复并重跑 package.mjs，不要再次创建草稿。' >&2
      exit 74
    fi
    printf '%s\n' "$RESULT"
    ;;
  *) exec "$SKILL_DIR/scripts/publish.sh" "$@" ;;
esac
