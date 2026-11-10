#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
plugin_root=$(cd "$here/../../.." && pwd)
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    exec powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$here/run.ps1")" "$@"
    ;;
esac
case "$(uname -s)/$(uname -m)" in
  Darwin/*) asset=disk-clean-macos-universal.tar.gz ;;
  Linux/x86_64) asset=disk-clean-linux-x86_64.tar.gz ;;
  Linux/aarch64 | Linux/arm64) asset=disk-clean-linux-arm64.tar.gz ;;
  *) asset= ;;
esac

data=${1:-}
[ "$#" -gt 0 ] && shift
case "$data" in
  '' | *\$\{*) data="$HOME/.cache/disk-clean" ;;
esac

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$plugin_root/.claude-plugin/plugin.json" | head -n 1)
case "$version" in
  '' | *[!0-9A-Za-z.+-]*)
    echo "disk-clean: could not read a valid version from $plugin_root/.claude-plugin/plugin.json" >&2
    exit 1
    ;;
esac

bin="$data/bin/disk-clean-$version"
if [ -x "$bin" ]; then
  exec "$bin" "$@"
fi

mkdir -p "$data/bin"
tmp=$(mktemp -d "$data/bin/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

releases=https://github.com/omridevk/mopper/releases
supported="macOS (arm64 and x86_64), Linux (x86_64 and arm64) and Windows (x86_64 and arm64)"

fail() {
  echo "disk-clean: $1" >&2
  echo "  Release binaries exist for $supported:" >&2
  echo "  $releases" >&2
  exit 1
}

[ -n "$asset" ] || fail "no release binary for $(uname -s)/$(uname -m)."
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the v$version release."
sum=(shasum -a 256)
command -v sha256sum >/dev/null 2>&1 && sum=(sha256sum)
command -v "${sum[0]}" >/dev/null 2>&1 || fail "sha256sum or shasum is needed to verify the v$version release."

url="$releases/download/disk-clean--v$version/$asset"
echo "disk-clean: downloading release v$version..." >&2
if ! curl --proto '=https' --tlsv1.2 -fsL --retry 2 -o "$tmp/$asset" "$url" ||
  ! curl --proto '=https' --tlsv1.2 -fsL --retry 2 -o "$tmp/$asset.sha256" "$url.sha256"; then
  fail "could not download $asset for v$version (no published release for this version, or no network)."
fi
if [ "$(awk '{print $2}' "$tmp/$asset.sha256")" != "$asset" ] ||
  ! (cd "$tmp" && "${sum[@]}" -c "$asset.sha256" >/dev/null 2>&1); then
  echo "disk-clean: checksum mismatch on the downloaded v$version release, refusing to run it" >&2
  exit 1
fi
tar -xzf "$tmp/$asset" -C "$tmp" disk-clean || fail "could not unpack $asset for v$version."
mv "$tmp/disk-clean" "$tmp/ready"

chmod 755 "$tmp/ready"
mv -f "$tmp/ready" "$bin"
rm -rf "$tmp"
trap - EXIT
exec "$bin" "$@"
