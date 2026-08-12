#!/usr/bin/env bash
# 이 PC(Linux)에서 게시판 서버를 켠다. 더블클릭 또는 ./start-board.sh
set -euo pipefail

cd "$(dirname "$0")"

# 이 PC 의 Node 24 는 ~/.local 에 사용자 권한으로 깔려 있다(로그인 셸에는 .profile 이 붙여준다).
export PATH="$HOME/.local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[board] node 를 찾을 수 없습니다. ~/.local/bin/node 확인이 필요합니다." >&2
  exit 1
fi

# 필요하면 아래 두 줄의 주석을 풀어 포트·토큰을 바꾼다.
# export BOARD_PORT=8787
# export BOARD_TOKEN=바꿀토큰

exec node src/index.ts
