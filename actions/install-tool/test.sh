#!/usr/bin/env bash
# Tests for install-tool.sh. Run: bash actions/install-tool/test.sh
#
# Part 1 tests the pure functions.
# Part 2 tests the install of a pin, with a fake download.
# Part 3 runs the real script as a process, with a fake "curl" and a fake "uname".
# Part 4 checks the real file tools.txt.
# The tests never use the network.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=actions/install-tool/install-tool.sh
source "$here/install-tool.sh"

failures=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: expected \"$expected\", got \"$actual\""
    failures=$((failures + 1))
  fi
}

# contains <name> <text that must be in the output> <output>
contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: \"$needle\" is not in the output:"
    while IFS= read -r line; do
      echo "        $line"
    done <<< "$haystack"
    failures=$((failures + 1))
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The SHA-256 of the three bytes "abc" is a well-known test value.
abc_sha='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
abc_sha_upper='BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'
sha_a='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
sha_b='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
sha_a_upper='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
sha_not_hex='zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'

# --- Part 1: the pure functions ---

check 'linux on x86_64' 'linux-x86_64' "$(platform_key Linux x86_64)"
check 'linux on aarch64' 'linux-arm64' "$(platform_key Linux aarch64)"
check 'mac on arm64' 'darwin-arm64' "$(platform_key Darwin arm64)"
check 'mac on x86_64' 'darwin-x86_64' "$(platform_key Darwin x86_64)"
check 'an unknown system fails' 'failed' "$(platform_key FreeBSD x86_64 2> /dev/null || echo failed)"
check 'an unknown processor fails' 'failed' "$(platform_key Linux riscv64 2> /dev/null || echo failed)"

printf 'abc' > "$work/abc"
check 'sha256 of a known file' "$abc_sha" "$(sha256_of "$work/abc")"
check 'verify accepts the right hash' 'ok' "$(verify_sha256 "$work/abc" "$abc_sha" 2> /dev/null && echo ok)"
check 'verify rejects another hash' 'failed' "$(verify_sha256 "$work/abc" "$sha_a" 2> /dev/null || echo failed)"
check 'verify rejects a hash in capital letters' 'failed' "$(verify_sha256 "$work/abc" "$abc_sha_upper" 2> /dev/null || echo failed)"
contains 'verify names the expected hash' "$sha_a" "$(verify_sha256 "$work/abc" "$sha_a" 2>&1 || true)"
contains 'verify names the real hash' "$abc_sha" "$(verify_sha256 "$work/abc" "$sha_a" 2>&1 || true)"
contains 'verify says the hash does not match' 'does not match' "$(verify_sha256 "$work/abc" "$sha_a" 2>&1 || true)"
check 'verify fails for a missing file' 'failed' "$(verify_sha256 "$work/missing" "$abc_sha" 2> /dev/null || echo failed)"

check 'tool names: a normal name' 'ok' "$(validate_tool_name actionlint 2> /dev/null && echo ok)"
check 'tool names: a dash and digits' 'ok' "$(validate_tool_name tool-2 2> /dev/null && echo ok)"
check 'tool names: an empty name fails' 'failed' "$(validate_tool_name '' 2> /dev/null || echo failed)"
check 'tool names: a path fails' 'failed' "$(validate_tool_name '../x' 2> /dev/null || echo failed)"
check 'tool names: a capital letter fails' 'failed' "$(validate_tool_name Actionlint 2> /dev/null || echo failed)"
check 'tool names: a leading dash fails' 'failed' "$(validate_tool_name -x 2> /dev/null || echo failed)"

# A manifest with two tools, two platforms, comments and a blank line.
cat > "$work/good.txt" << EOT
# tool  version  platform  sha256  url

alpha 1.2.3 linux-x86_64 $sha_a https://example.invalid/releases/v1.2.3/alpha_linux.tar.gz
alpha 1.2.3 darwin-arm64 $sha_b https://example.invalid/releases/v1.2.3/alpha_mac.tar.gz  # a comment at the end
beta  0.9.0 linux-x86_64 $sha_b https://example.invalid/releases/v0.9.0/beta_linux.tar.gz
EOT
check 'pin: the right row for tool and platform' "1.2.3 $sha_a https://example.invalid/releases/v1.2.3/alpha_linux.tar.gz" "$(pin_for "$work/good.txt" alpha linux-x86_64)"
check 'pin: the other platform' "1.2.3 $sha_b https://example.invalid/releases/v1.2.3/alpha_mac.tar.gz" "$(pin_for "$work/good.txt" alpha darwin-arm64)"
check 'pin: the other tool' "0.9.0 $sha_b https://example.invalid/releases/v0.9.0/beta_linux.tar.gz" "$(pin_for "$work/good.txt" beta linux-x86_64)"
check 'pin: an unknown tool fails' 'failed' "$(pin_for "$work/good.txt" gamma linux-x86_64 2> /dev/null || echo failed)"
contains 'pin: the message of an unknown tool' 'no pin for gamma on linux-x86_64' "$(pin_for "$work/good.txt" gamma linux-x86_64 2>&1 || true)"
check 'pin: a platform with no row fails' 'failed' "$(pin_for "$work/good.txt" beta darwin-arm64 2> /dev/null || echo failed)"
check 'pin: a missing manifest fails' 'failed' "$(pin_for "$work/nothing.txt" alpha linux-x86_64 2> /dev/null || echo failed)"
check 'pin: a bad tool name fails' 'failed' "$(pin_for "$work/good.txt" '../alpha' linux-x86_64 2> /dev/null || echo failed)"

printf 'alpha 1.2.3 linux-x86_64 %s https://example.invalid/a.tar.gz\r\n' "$sha_a" > "$work/crlf.txt"
check 'pin: a file with Windows line ends works' "1.2.3 $sha_a https://example.invalid/a.tar.gz" "$(pin_for "$work/crlf.txt" alpha linux-x86_64)"

# Each bad manifest must fail, even when the bad row is not the row that the caller asks for.
bad_manifest() {
  local name="$1" row="$2"
  printf 'alpha 1.2.3 linux-x86_64 %s https://example.invalid/a.tar.gz\n%s\n' "$sha_a" "$row" > "$work/bad.txt"
  check "pin: $name fails" 'failed' "$(pin_for "$work/bad.txt" alpha linux-x86_64 2> /dev/null || echo failed)"
}
bad_manifest 'a row with 4 fields' "beta 1.0.0 linux-x86_64 $sha_a"
bad_manifest 'a row with 6 fields' "beta 1.0.0 linux-x86_64 $sha_a https://example.invalid/b.tar.gz extra"
bad_manifest 'a short hash' 'beta 1.0.0 linux-x86_64 abc123 https://example.invalid/b.tar.gz'
bad_manifest 'a hash in capital letters' "beta 1.0.0 linux-x86_64 $sha_a_upper https://example.invalid/b.tar.gz"
bad_manifest 'a hash that is not hex' "beta 1.0.0 linux-x86_64 $sha_not_hex https://example.invalid/b.tar.gz"
bad_manifest 'a url with http' "beta 1.0.0 linux-x86_64 $sha_a http://example.invalid/b.tar.gz"
bad_manifest 'a url with the file scheme' "beta 1.0.0 linux-x86_64 $sha_a file:///etc/passwd"
bad_manifest 'a tool name with a capital' "Beta 1.0.0 linux-x86_64 $sha_a https://example.invalid/b.tar.gz"
bad_manifest 'a version with a slash' "beta 1.0/0 linux-x86_64 $sha_a https://example.invalid/b.tar.gz"
bad_manifest 'a platform with a slash' "beta 1.0.0 linux/x86_64 $sha_a https://example.invalid/b.tar.gz"
bad_manifest 'the same tool and platform twice' "alpha 2.0.0 linux-x86_64 $sha_b https://example.invalid/a2.tar.gz"

# --- Part 2: install a pin, with a fake download ---

# make_archive <dir> <member name> <content>: writes <dir>/archive.tar.gz
make_archive() {
  local dir="$1" member="$2" content="$3"
  mkdir -p "$dir/src"
  printf '%s\n' "$content" > "$dir/src/$member"
  printf 'licence text\n' > "$dir/src/LICENSE"
  tar -czf "$dir/archive.tar.gz" -C "$dir/src" "$member" LICENSE
}

make_archive "$work/good" alpha $'#!/bin/sh\necho "alpha runs"'
good_sha="$(sha256_of "$work/good/archive.tar.gz")"
make_archive "$work/other" alpha $'#!/bin/sh\necho "a different alpha"'
make_archive "$work/nomember" zeta 'not the tool'

fake_source=''
requested=''
# The tests replace the function "download". The script calls it with: url, destination.
download() {
  requested="${requested}$1 "
  cp "$fake_source" "$2"
}

fake_source="$work/good/archive.tar.gz"
requested=''
dir="$(install_pin alpha 1.2.3 "$good_sha" https://example.invalid/alpha.tar.gz "$work/root1" 2> /dev/null)"
# The download ran in a subshell, so the variable "requested" is checked in the process tests (Part 3).
check 'install: the directory has the tool and the version' "$work/root1/alpha-1.2.3" "$dir"
check 'install: the file exists' 'ok' "$([[ -f "$dir/alpha" ]] && echo ok)"
check 'install: the file can run' 'alpha runs' "$("$dir/alpha")"
check 'install: only the tool is extracted' 'missing' "$([[ -e "$dir/LICENSE" ]] && echo present || echo missing)"

fake_source="$work/other/archive.tar.gz"
if out="$(install_pin alpha 1.2.3 "$good_sha" https://example.invalid/alpha.tar.gz "$work/root2" 2>&1)"; then
  echo 'FAIL  install: an archive with another hash must fail'
  failures=$((failures + 1))
else
  echo 'ok    install: an archive with another hash fails'
fi
contains 'install: the failure says the hash does not match' 'does not match' "$out"
check 'install: nothing is extracted after a hash failure' 'missing' "$([[ -e "$work/root2/alpha-1.2.3/alpha" ]] && echo present || echo missing)"

fake_source="$work/nomember/archive.tar.gz"
nomember_sha="$(sha256_of "$fake_source")"
check 'install: an archive with no file of the tool name fails' 'failed' "$(install_pin alpha 1.2.3 "$nomember_sha" https://example.invalid/alpha.tar.gz "$work/root3" 2> /dev/null || echo failed)"

download() { return 22; }
check 'install: a failed download fails' 'failed' "$(install_pin alpha 1.2.3 "$good_sha" https://example.invalid/alpha.tar.gz "$work/root4" 2> /dev/null || echo failed)"

# --- Part 3: the real script as a process ---

# A fake "curl" copies $FAKE_ARCHIVE to the --output file and logs the url. A fake "uname" says Linux x86_64.
fakebin="$work/fakebin"
mkdir -p "$fakebin"
cat > "$fakebin/curl" << 'EOT'
#!/usr/bin/env bash
out=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --retry | --retry-delay | --proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$FAKE_CURL_LOG"
cp "$FAKE_ARCHIVE" "$out"
EOT
cat > "$fakebin/uname" << 'EOT'
#!/usr/bin/env bash
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
esac
EOT
chmod +x "$fakebin/curl" "$fakebin/uname"

cat > "$work/proc.txt" << EOT
alpha 1.2.3 linux-x86_64 $good_sha https://example.invalid/releases/v1.2.3/alpha.tar.gz
EOT

# run_script <archive> [arguments of the script]: runs the script, then prints the exit code and the output
run_script() {
  local archive="$1"
  shift
  : > "$work/curl.log"
  : > "$work/github_path"
  : > "$work/github_output"
  local code=0 output
  output="$(PATH="$fakebin:$PATH" FAKE_ARCHIVE="$archive" FAKE_CURL_LOG="$work/curl.log" \
    INSTALL_TOOL_MANIFEST="$work/proc.txt" INSTALL_TOOL_ROOT="$work/proc-root" \
    GITHUB_PATH="$work/github_path" GITHUB_OUTPUT="$work/github_output" \
    bash "$here/install-tool.sh" "$@" 2>&1)" || code=$?
  echo "exit=$code"
  echo "$output"
}

out="$(run_script "$work/good/archive.tar.gz" alpha)"
contains 'process: a good archive exits 0' 'exit=0' "$out"
contains 'process: it tells which version is ready' 'alpha 1.2.3' "$out"
check 'process: the tool directory goes to GITHUB_PATH' "$work/proc-root/alpha-1.2.3" "$(cat "$work/github_path")"
check 'process: the version goes to GITHUB_OUTPUT' 'version=1.2.3' "$(cat "$work/github_output")"
check 'process: the script asks for the archive and nothing else' 'https://example.invalid/releases/v1.2.3/alpha.tar.gz' "$(cat "$work/curl.log")"
check 'process: the installed tool runs' 'alpha runs' "$("$work/proc-root/alpha-1.2.3/alpha")"

rm -rf "$work/proc-root"
out="$(run_script "$work/other/archive.tar.gz" alpha)"
contains 'process: a changed archive exits 1' 'exit=1' "$out"
contains 'process: a changed archive says the hash does not match' 'does not match' "$out"
check 'process: a changed archive adds nothing to GITHUB_PATH' '' "$(cat "$work/github_path")"
check 'process: a changed archive adds nothing to GITHUB_OUTPUT' '' "$(cat "$work/github_output")"
check 'process: a changed archive leaves no tool' 'missing' "$([[ -e "$work/proc-root/alpha-1.2.3/alpha" ]] && echo present || echo missing)"

out="$(run_script "$work/good/archive.tar.gz" unknown)"
contains 'process: an unknown tool exits 1' 'exit=1' "$out"
contains 'process: an unknown tool is named in the message' 'no pin for unknown' "$out"
check 'process: an unknown tool downloads nothing' '' "$(cat "$work/curl.log")"

out="$(run_script "$work/good/archive.tar.gz")"
contains 'process: no argument exits 2' 'exit=2' "$out"
contains 'process: no argument shows the usage' 'usage' "$out"

# --- Part 4: the real file tools.txt ---

real="$here/tools.txt"
check 'tools.txt: every row is valid' 'ok' "$(check_manifest "$real" 2> /dev/null && echo ok)"
for tool in actionlint gitleaks; do
  pin="$(pin_for "$real" "$tool" linux-x86_64 2> /dev/null || true)"
  version='' sha='' url=''
  read -r version sha url <<< "$pin"
  check "tools.txt: $tool has a pin for linux-x86_64" 'ok' "$([[ -n "$pin" ]] && echo ok)"
  contains "tools.txt: the url of $tool has the version" "/v${version}/" "$url"
  contains "tools.txt: the url of $tool is a GitHub release" 'https://github.com/' "$url"
done

if [[ "$failures" -gt 0 ]]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo 'all tests passed'
