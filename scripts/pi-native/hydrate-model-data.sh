#!/usr/bin/env bash
set -Eeuo pipefail

trap 'echo "Model data hydration failed at line $LINENO" >&2' ERR

if (( $# != 1 )); then
  echo "Usage: hydrate-model-data.sh <worktree>" >&2
  exit 2
fi

worktree=$(realpath "$1")
package_json="$worktree/packages/ai/package.json"
data_dir="$worktree/packages/ai/src/providers/data"

[[ -f $package_json && ! -L $package_json ]] || {
  echo "packages/ai/package.json must be a regular file in the worktree" >&2
  exit 1
}

mapfile -t package_metadata < <(node -e '
  const pkg = require(process.argv[1]);
  console.log(pkg.name);
  console.log(pkg.version);
  console.log(pkg.scripts?.["check:model-data"] ? "required" : "unused");
' "$package_json")
package_name=${package_metadata[0]}
version=${package_metadata[1]}
model_data=${package_metadata[2]}

if [[ $model_data == unused ]]; then
  exit 0
fi
if [[ $package_name != @earendil-works/pi-ai || ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Unexpected Pi AI package identity: $package_name@$version" >&2
  exit 1
fi
echo "Hydrating model data from $package_name@$version"

tmp_dir=$(mktemp -d)
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

mapfile -t dist_metadata < <(npm view "$package_name@$version" dist.tarball dist.integrity --json --min-release-age=0 | node -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const dist = JSON.parse(input);
    console.log(dist["dist.tarball"]);
    console.log(dist["dist.integrity"]);
  });
')
tarball_url=${dist_metadata[0]}
integrity=${dist_metadata[1]}
expected_url="https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-$version.tgz"
if [[ $tarball_url != "$expected_url" || $integrity != sha512-* ]]; then
  echo "Unexpected Pi AI distribution metadata" >&2
  exit 1
fi

npm pack "$package_name@$version" --ignore-scripts --pack-destination "$tmp_dir" --min-release-age=0 --silent >/dev/null
archive="$tmp_dir/earendil-works-pi-ai-$version.tgz"
[[ -f $archive && ! -L $archive ]] || {
  echo "Official Pi AI archive was not downloaded as expected" >&2
  exit 1
}
actual_integrity="sha512-$(openssl dgst -sha512 -binary "$archive" | base64 -w0)"
[[ $actual_integrity == "$integrity" ]] || {
  echo "Official Pi AI archive integrity mismatch" >&2
  exit 1
}

mkdir "$tmp_dir/extracted"
tar -xzf "$archive" -C "$tmp_dir/extracted" package/dist/providers/data
source_data="$tmp_dir/extracted/package/dist/providers/data"
[[ -f $source_data/.manifest.json ]] || {
  echo "Official Pi AI archive does not contain model data" >&2
  exit 1
}
if [[ -n $(find "$source_data" \( -type l -o \( ! -type d ! -type f \) \) -print -quit) ]]; then
  echo "Official Pi AI model data contains unsupported filesystem entries" >&2
  exit 1
fi

rm -rf "$data_dir"
mkdir -p "$(dirname "$data_dir")"
cp -a "$source_data" "$data_dir"
