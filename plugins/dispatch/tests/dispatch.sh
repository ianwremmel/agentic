#!/bin/sh
# Tiny POSIX-sh test runner for plugins/dispatch/bin/dispatch.
#
# Each test_* function in this file is run in a fresh temp dir with a
# fresh copy of the wrapper, its own VERSION/checksums.txt, and an
# isolated DISPATCH_CACHE_DIR. Failures print context and increment the
# failure count; the script exits non-zero if any test failed.

set -u

REPO_ROOT=$(cd -P "$(dirname "$0")/../../.." && pwd)
WRAPPER_SRC=$REPO_ROOT/plugins/dispatch/bin/dispatch

PASS=0
FAIL=0

# Real-binary sha256 of an empty file, just so we have a known
# non-zero hash to plug into checksums.txt when a test doesn't care
# about hash matching specifically.
SHA_EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

#######################################################################
# Helpers
#######################################################################

# Set up a fresh wrapper sandbox at $WORK with a writable VERSION and
# checksums.txt + an isolated cache.
new_sandbox() {
    WORK=$(mktemp -d)
    mkdir -p "$WORK/bin" "$WORK/cache" "$WORK/release"
    cp "$WRAPPER_SRC" "$WORK/bin/dispatch"
    chmod +x "$WORK/bin/dispatch"
    printf '9.9.9\n' >"$WORK/bin/VERSION"
    : >"$WORK/bin/checksums.txt"
    DISPATCH=$WORK/bin/dispatch
    CACHE=$WORK/cache
}

cleanup_sandbox() {
    [ -n "${WORK:-}" ] && rm -rf "$WORK"
}

# Detect the current host target the same way the wrapper does, so
# tests can pre-stage the right checksum line.
host_target() {
    case $(uname -s) in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) os=unknown ;;
    esac
    case $(uname -m) in
        x86_64 | amd64) arch=x64 ;;
        arm64 | aarch64) arch=arm64 ;;
        *) arch=unknown ;;
    esac
    printf '%s-%s' "$os" "$arch"
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

assert_eq() {
    label=$1
    expected=$2
    actual=$3
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS + 1))
        printf '  ok  %s\n' "$label"
    else
        FAIL=$((FAIL + 1))
        printf '  FAIL %s\n        want: %s\n        got:  %s\n' "$label" "$expected" "$actual"
    fi
}

run_test() {
    name=$1
    printf '\n# %s\n' "$name"
    new_sandbox
    # Each test function: receives no args, may read DISPATCH/CACHE/WORK.
    "$name"
    cleanup_sandbox
}

#######################################################################
# Tests
#######################################################################

# Missing VERSION file → exit 65.
test_missing_version() {
    rm "$WORK/bin/VERSION"
    out=$("$DISPATCH" 2>&1 || true)
    code=$(sh -c "\"$DISPATCH\" >/dev/null 2>&1; echo \$?")
    assert_eq "exit code is 65" "65" "$code"
    case $out in
        *"missing VERSION file"*) assert_eq "error mentions VERSION" "1" "1" ;;
        *) assert_eq "error mentions VERSION" "1" "0" ;;
    esac
}

# Unknown OS/arch combination → exit 64.
# We use a PATH-shadowing fake `uname` to inject the values.
test_unknown_arch() {
    fake=$WORK/fake
    mkdir -p "$fake"
    cat >"$fake/uname" <<'EOF'
#!/bin/sh
case "$1" in
    -s) echo Linux ;;
    -m) echo riscv64 ;;
    *) echo Linux ;;
esac
EOF
    chmod +x "$fake/uname"
    code=$(PATH="$fake:$PATH" sh -c "\"$DISPATCH\" >/dev/null 2>&1; echo \$?")
    assert_eq "unknown arch exits 64" "64" "$code"
}

# checksums.txt entry exists but is a placeholder zero-hash → exit 66.
test_placeholder_hash_rejected() {
    target=$(host_target)
    printf '0000000000000000000000000000000000000000000000000000000000000000  dispatch-%s\n' "$target" >"$WORK/bin/checksums.txt"
    code=$(DISPATCH_CACHE_DIR=$CACHE sh -c "\"$DISPATCH\" >/dev/null 2>&1; echo \$?")
    assert_eq "placeholder zero-hash exits 66" "66" "$code"
}

# Checksum mismatch when downloading → exit 68.
test_checksum_mismatch() {
    target=$(host_target)
    # Real binary stub:
    stub=$WORK/release/dispatch-$target
    cat >"$stub" <<'EOF'
#!/bin/sh
echo "stub-$@"
EOF
    chmod +x "$stub"
    # Put the WRONG sha (sha of empty) into checksums.txt so download
    # succeeds but verification fails.
    printf '%s  dispatch-%s\n' "$SHA_EMPTY" "$target" >"$WORK/bin/checksums.txt"
    code=$(
        DISPATCH_CACHE_DIR=$CACHE \
        DISPATCH_DOWNLOAD_URL="file://$WORK/release" \
        sh -c "\"$DISPATCH\" >/dev/null 2>&1; echo \$?"
    )
    assert_eq "checksum mismatch exits 68" "68" "$code"
}

# Happy path: download a stub via file://, verify checksum, exec it.
test_happy_path() {
    target=$(host_target)
    stub=$WORK/release/dispatch-$target
    cat >"$stub" <<'EOF'
#!/bin/sh
printf 'stub-ok args=%s\n' "$*"
EOF
    chmod +x "$stub"
    sha=$(sha256_of "$stub")
    printf '%s  dispatch-%s\n' "$sha" "$target" >"$WORK/bin/checksums.txt"

    out=$(
        DISPATCH_CACHE_DIR=$CACHE \
        DISPATCH_DOWNLOAD_URL="file://$WORK/release" \
        "$DISPATCH" hello world
    )
    assert_eq "happy path output" "stub-ok args=hello world" "$out"

    # Second invocation should hit the cache (no re-download needed).
    rm -rf "$WORK/release"
    out2=$(
        DISPATCH_CACHE_DIR=$CACHE \
        DISPATCH_DOWNLOAD_URL="file:///does-not-exist" \
        "$DISPATCH" cached
    )
    assert_eq "cached invocation output" "stub-ok args=cached" "$out2"
}

# --dispatch-clean-cache purges DISPATCH_CACHE_DIR and exits 0.
test_clean_cache() {
    mkdir -p "$CACHE/9.9.9"
    : >"$CACHE/9.9.9/dispatch-linux-x64"
    code=$(DISPATCH_CACHE_DIR=$CACHE sh -c "\"$DISPATCH\" --dispatch-clean-cache >/dev/null 2>&1; echo \$?")
    assert_eq "clean-cache exits 0" "0" "$code"
    if [ -d "$CACHE" ]; then
        assert_eq "cache dir removed" "removed" "still-there"
    else
        assert_eq "cache dir removed" "removed" "removed"
    fi
}

# Network fetch refused when DISPATCH_SKIP_DOWNLOAD is set → exit 67.
test_skip_download() {
    target=$(host_target)
    printf '%s  dispatch-%s\n' "$SHA_EMPTY" "$target" >"$WORK/bin/checksums.txt"
    code=$(
        DISPATCH_CACHE_DIR=$CACHE \
        DISPATCH_SKIP_DOWNLOAD=1 \
        sh -c "\"$DISPATCH\" >/dev/null 2>&1; echo \$?"
    )
    assert_eq "skip-download exits 67" "67" "$code"
}

#######################################################################
# Driver
#######################################################################

run_test test_missing_version
run_test test_unknown_arch
run_test test_placeholder_hash_rejected
run_test test_checksum_mismatch
run_test test_happy_path
run_test test_clean_cache
run_test test_skip_download

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
