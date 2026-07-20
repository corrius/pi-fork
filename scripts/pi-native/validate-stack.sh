#!/usr/bin/env bash
set -Eeuo pipefail

UPSTREAM_URL="${PI_NATIVE_UPSTREAM_URL:-https://github.com/earendil-works/pi-mono.git}"
FORK_URL="${PI_NATIVE_FORK_URL:-https://github.com/corrius/pi-fork.git}"
STACK_BRANCH="${PI_NATIVE_STACK_BRANCH:-feat/ac/openai-codex-compaction-stack}"
PACKAGE="@earendil-works/pi-coding-agent"
VERSION=""
STACK_REVISION=""

usage() {
  cat <<'EOF'
Usage: validate-stack.sh [--version <version>] [--stack-revision <commit>]

Replay the native-compaction stack onto an official Pi release, then run checks,
the build, the full test suite, and a CLI version smoke test. The source branch
is never modified.

Environment overrides:
  PI_NATIVE_UPSTREAM_URL
  PI_NATIVE_FORK_URL
  PI_NATIVE_STACK_BRANCH
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
    --stack-revision)
      [[ $# -ge 2 ]] || { echo "Missing value for --stack-revision" >&2; exit 2; }
      STACK_REVISION="$2"
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
if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid Pi version: $VERSION" >&2
  exit 2
fi
if [[ -n $STACK_REVISION && ! $STACK_REVISION =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid stack revision: $STACK_REVISION" >&2
  exit 2
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
fetched_revision=$(git -C "$repo" rev-parse "$stack_ref")
if [[ -n $STACK_REVISION && $fetched_revision != "$STACK_REVISION" ]]; then
  echo "Stack branch moved: expected $STACK_REVISION, fetched $fetched_revision" >&2
  exit 1
fi
STACK_REVISION=${STACK_REVISION:-$fetched_revision}

tag_revision=$(git -C "$repo" rev-parse "refs/tags/$TAG^{commit}")
stack_base=$(git -C "$repo" merge-base "$tag_revision" "$STACK_REVISION")
git -C "$repo" merge-base --is-ancestor "$stack_base" "$tag_revision"
git -C "$repo" merge-base --is-ancestor "$stack_base" "$STACK_REVISION"
mapfile -t commits < <(git -C "$repo" rev-list --reverse "$stack_base..$STACK_REVISION")
if [[ ${#commits[@]} -eq 0 ]]; then
  echo "No stack commits found after $stack_base" >&2
  exit 1
fi

git -C "$repo" config user.name "Pi Native CI"
git -C "$repo" config user.email "corrius@gmail.com"
git -C "$repo" worktree add --detach "$staging" "$TAG"
git -C "$staging" cherry-pick "${commits[@]}"

(
  cd "$staging"
  npm ci --ignore-scripts
  npm run check
  git diff --exit-code

  tsgo=node_modules/@typescript/native-preview/bin/tsgo.js
  for package in tui ai agent coding-agent orchestrator; do
    node "$tsgo" -p "packages/$package/tsconfig.build.json"
  done
  chmod +x packages/coding-agent/dist/cli.js packages/coding-agent/dist/rpc-entry.js
  chmod +x packages/orchestrator/dist/cli.js
  mkdir -p \
    packages/coding-agent/dist/modes/interactive/theme \
    packages/coding-agent/dist/modes/interactive/assets \
    packages/coding-agent/dist/core/export-html/vendor
  cp packages/coding-agent/src/modes/interactive/theme/*.json \
    packages/coding-agent/dist/modes/interactive/theme/
  cp packages/coding-agent/src/modes/interactive/assets/*.png \
    packages/coding-agent/dist/modes/interactive/assets/
  cp packages/coding-agent/src/core/export-html/template.{html,css,js} \
    packages/coding-agent/dist/core/export-html/
  cp packages/coding-agent/src/core/export-html/vendor/*.js \
    packages/coding-agent/dist/core/export-html/vendor/

  test_home="$work_dir/test-home"
  mkdir -p "$test_home/cache" "$test_home/tmp"
  HOME="$test_home" XDG_CACHE_HOME="$test_home/cache" TMPDIR="$test_home/tmp" ./test.sh
  node packages/coding-agent/dist/cli.js --version | grep -Fx "$VERSION"
)

echo "Validated Pi $VERSION with stack ${STACK_REVISION:0:8}"
