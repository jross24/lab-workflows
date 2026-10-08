#!/usr/bin/env bash
# Installs one tool that has a pin in tools.txt. Run: bash install-tool.sh <tool>
#
# A pin holds the version, the download url and the SHA-256 of the download.
# The script checks the SHA-256 of the file before it extracts or runs anything.
# It never asks the network for a checksum. The only trusted value is the pin in this repository.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

readonly SHA256_PATTERN='^[0-9a-f]{64}$'
readonly TOOL_PATTERN='^[a-z0-9][a-z0-9-]*$'
readonly VERSION_PATTERN='^[0-9A-Za-z][0-9A-Za-z.+_-]*$'
readonly PLATFORM_PATTERN='^[a-z0-9][a-z0-9_-]*$'

fail() {
  echo "install-tool: $*" >&2
  return 1
}

# platform_key <uname -s> <uname -m>: prints a key such as linux-x86_64
platform_key() {
  local os="$1" arch="$2"
  case "$os" in
    Linux) os='linux' ;;
    Darwin) os='darwin' ;;
    *) fail "the system \"$os\" is not supported"; return 1 ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch='x86_64' ;;
    aarch64 | arm64) arch='arm64' ;;
    *) fail "the processor \"$arch\" is not supported"; return 1 ;;
  esac
  echo "${os}-${arch}"
}

validate_tool_name() {
  if [[ ! "$1" =~ $TOOL_PATTERN ]]; then
    fail "\"$1\" is not a tool name (lower case letters, digits and dashes)"
    return 1
  fi
}

# sha256_of <file>: prints the SHA-256 of a file as 64 lower case hex characters
sha256_of() {
  local file="$1" line
  if command -v sha256sum > /dev/null; then
    line="$(sha256sum "$file")"
  elif command -v shasum > /dev/null; then
    line="$(shasum -a 256 "$file")"
  else
    fail 'there is no sha256sum or shasum on this machine'
    return 1
  fi
  echo "${line%% *}"
}

# verify_sha256 <file> <expected sha256>: fails when the file has another hash
verify_sha256() {
  local file="$1" expected="$2" actual
  if [[ ! -f "$file" ]]; then
    fail "the file \"$file\" does not exist"
    return 1
  fi
  if [[ ! "$expected" =~ $SHA256_PATTERN ]]; then
    fail "the pinned hash \"$expected\" is not 64 lower case hex characters"
    return 1
  fi
  actual="$(sha256_of "$file")"
  if [[ "$actual" != "$expected" ]]; then
    fail "the SHA-256 of the download does not match the pin. pinned: $expected, downloaded: $actual"
    return 1
  fi
}

# check_manifest <manifest>: checks that every row is well formed and that no tool and platform appear twice
check_manifest() {
  local manifest="$1" line tool version platform sha url extra seen=' '
  if [[ ! -f "$manifest" ]]; then
    fail "the pin file \"$manifest\" does not exist"
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line%%#*}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    tool='' version='' platform='' sha='' url='' extra=''
    read -r tool version platform sha url extra <<< "$line"
    if [[ -z "$url" || -n "$extra" ]]; then
      fail "a row needs exactly 5 fields (tool version platform sha256 url): $line"
      return 1
    fi
    [[ "$tool" =~ $TOOL_PATTERN ]] || { fail "bad tool name in the row: $line"; return 1; }
    [[ "$version" =~ $VERSION_PATTERN ]] || { fail "bad version in the row: $line"; return 1; }
    [[ "$platform" =~ $PLATFORM_PATTERN ]] || { fail "bad platform in the row: $line"; return 1; }
    [[ "$sha" =~ $SHA256_PATTERN ]] || { fail "the hash must be 64 lower case hex characters in the row: $line"; return 1; }
    [[ "$url" == https://* ]] || { fail "the url must start with https:// in the row: $line"; return 1; }
    if [[ "$seen" == *" ${tool}@${platform} "* ]]; then
      fail "two rows for $tool on $platform"
      return 1
    fi
    seen="${seen}${tool}@${platform} "
  done < "$manifest"
}

# pin_for <manifest> <tool> <platform>: prints "<version> <sha256> <url>"
pin_for() {
  local manifest="$1" tool="$2" platform="$3" line f_tool f_version f_platform f_sha f_url
  validate_tool_name "$tool" || return 1
  check_manifest "$manifest" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line%%#*}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    read -r f_tool f_version f_platform f_sha f_url <<< "$line"
    if [[ "$f_tool" == "$tool" && "$f_platform" == "$platform" ]]; then
      echo "$f_version $f_sha $f_url"
      return 0
    fi
  done < "$manifest"
  fail "no pin for $tool on $platform in $manifest"
  return 1
}

# download <url> <destination>
download() {
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
    --proto '=https' --tlsv1.2 --output "$2" "$1"
}

# install_pin <tool> <version> <sha256> <url> <root>: prints the directory with the tool
# The file with the name of the tool must be at the top of the archive.
install_pin() {
  local tool="$1" version="$2" sha="$3" url="$4" root="$5" work dir
  work="$(mktemp -d)"
  if ! download "$url" "$work/archive"; then
    rm -rf "$work"
    fail "the download of $url failed"
    return 1
  fi
  if ! verify_sha256 "$work/archive" "$sha"; then
    rm -rf "$work"
    return 1
  fi
  dir="$root/${tool}-${version}"
  mkdir -p "$dir"
  if ! tar -xzf "$work/archive" -C "$dir" -- "$tool"; then
    rm -rf "$work"
    fail "the archive has no file named $tool"
    return 1
  fi
  rm -rf "$work"
  if [[ ! -f "$dir/$tool" || -L "$dir/$tool" ]]; then
    fail "$dir/$tool is not a regular file"
    return 1
  fi
  chmod +x "$dir/$tool"
  echo "$dir"
}

main() {
  local tool="${1:-}"
  if [[ -z "$tool" ]]; then
    echo 'usage: install-tool.sh <tool>' >&2
    exit 2
  fi
  local manifest="${INSTALL_TOOL_MANIFEST:-$here/tools.txt}"
  local root="${INSTALL_TOOL_ROOT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lab-tools}"
  local platform pin version sha url dir
  platform="$(platform_key "$(uname -s)" "$(uname -m)")" || exit 1
  pin="$(pin_for "$manifest" "$tool" "$platform")" || exit 1
  read -r version sha url <<< "$pin"
  echo "install-tool: $tool $version for $platform" >&2
  dir="$(install_pin "$tool" "$version" "$sha" "$url" "$root")" || exit 1
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "$dir" >> "$GITHUB_PATH"
  fi
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "version=${version}" >> "$GITHUB_OUTPUT"
  fi
  echo "install-tool: $tool $version is ready in $dir. The SHA-256 of the download matches the pin."
}

# Run main only when the file is run as a script. The tests source the file.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
