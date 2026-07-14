#!/usr/bin/env bash
set -Eeuo pipefail

UPSTREAM_URL="${PI_NATIVE_UPSTREAM_URL:-https://github.com/earendil-works/pi-mono.git}"
FORK_URL="${PI_NATIVE_FORK_URL:-https://github.com/corrius/pi-fork.git}"
STACK_BRANCH="${PI_NATIVE_STACK_BRANCH:-feat/ac/openai-codex-compaction-stack}"
STACK_BASE="${PI_NATIVE_STACK_BASE:-bc469b03389135edf5d179ab7718c2085cdfd3a9}"
PACKAGE="@earendil-works/pi-coding-agent"
VERSION=""

usage() {
  cat <<'EOF'
Usage: validate-stack.sh [--version <version>]

Replay the native-compaction stack onto an official Pi release, then run checks,
the build, the full test suite, and a CLI version smoke test. The source branch
is never modified.

Environment overrides:
  PI_NATIVE_UPSTREAM_URL
  PI_NATIVE_FORK_URL
  PI_NATIVE_STACK_BRANCH
  PI_NATIVE_STACK_BASE
  PI_NATIVE_WORK_ROOT (defaults to /tmp)
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || { echo "Missing value for --version" >&2; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z $VERSION ]]; then
  VERSION=$(npm view "$PACKAGE" version)
fi
TAG="v$VERSION"

work_root="${PI_NATIVE_WORK_ROOT:-/tmp}"
mkdir -p "$work_root"
work_dir=$(mktemp -d "$work_root/pi-native-validation.XXXXXX")
repo="$work_dir/repo"
staging="$work_dir/build"
cleanup() {
  git -C "$repo" worktree remove --force "$staging" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

echo "Validating Pi $VERSION with $STACK_BRANCH"
git clone --filter=blob:none --no-checkout "$UPSTREAM_URL" "$repo"
git -C "$repo" remote add fork "$FORK_URL"
git -C "$repo" fetch origin "refs/tags/$TAG:refs/tags/$TAG"
git -C "$repo" fetch fork "refs/heads/$STACK_BRANCH:refs/remotes/fork/$STACK_BRANCH"

stack_ref="refs/remotes/fork/$STACK_BRANCH"
git -C "$repo" rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null
git -C "$repo" merge-base --is-ancestor "$STACK_BASE" "$stack_ref"
mapfile -t commits < <(git -C "$repo" rev-list --reverse "$STACK_BASE..$stack_ref")
if [[ ${#commits[@]} -eq 0 ]]; then
  echo "No stack commits found after $STACK_BASE" >&2
  exit 1
fi

git -C "$repo" config user.name "Pi Native CI"
git -C "$repo" config user.email "corrius@gmail.com"
git -C "$repo" worktree add --detach "$staging" "$TAG"
git -C "$staging" cherry-pick "${commits[@]}"

(
  cd "$staging"
  npm install
  npm run check
  git diff --exit-code
  npm run build

  test_home="$work_dir/test-home"
  mkdir -p "$test_home/cache" "$test_home/tmp"
  HOME="$test_home" XDG_CACHE_HOME="$test_home/cache" TMPDIR="$test_home/tmp" ./test.sh
  node packages/coding-agent/dist/cli.js --version | grep -Fx "$VERSION"
)

stack_revision=$(git -C "$repo" rev-parse "$stack_ref")
echo "Validated Pi $VERSION with stack ${stack_revision:0:8}"
