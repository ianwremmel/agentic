#!/usr/bin/env bats

setup() {
  source "./scripts/lib/_retry.bash"
}

# --- Script structure tests ---

@test "_retry library file exists" {
  [[ -f "./scripts/lib/_retry.bash" ]]
}

@test "_retry library file is not executable" {
  [[ ! -x "./scripts/lib/_retry.bash" ]]
}

# --- Argument validation tests ---

@test "retry requires at least 3 arguments" {
  run retry 3 1

  [[ $status -eq 2 ]]
  [[ $output == *"retry requires at least 3 arguments"* ]]
}

@test "retry with no arguments fails" {
  run retry

  [[ $status -eq 2 ]]
  [[ $output == *"retry requires at least 3 arguments"* ]]
}

# --- Success tests ---

@test "retry succeeds on first try" {
  run retry 3 0 true

  [[ $status -eq 0 ]]
}

@test "retry passes output from successful command" {
  run retry 3 0 echo "hello world"

  [[ $status -eq 0 ]]
  [[ $output == *"hello world"* ]]
}

# --- Retry behavior tests ---

@test "retry retries and succeeds on second attempt" {
  TEST_TEMP_DIR="$(mktemp -d)"
  echo "0" > "$TEST_TEMP_DIR/count"

  flaky_command() {
    local count
    count=$(cat "$TEST_TEMP_DIR/count")
    count=$((count + 1))
    echo "$count" > "$TEST_TEMP_DIR/count"
    if [[ $count -lt 2 ]]; then
      return 1
    fi
    echo "success"
    return 0
  }
  export TEST_TEMP_DIR
  export -f flaky_command

  run retry 3 0 flaky_command

  [[ $status -eq 0 ]]
  [[ $output == *"success"* ]]

  rm -rf "$TEST_TEMP_DIR"
}

# --- Failure tests ---

@test "retry gives up after max_attempts" {
  run retry 3 0 false

  [[ $status -ne 0 ]]
  [[ $output == *"command failed after 3 attempts"* ]]
}

@test "retry returns the command's exit code on final failure" {
  fail_with_42() {
    return 42
  }
  export -f fail_with_42

  run retry 2 0 fail_with_42

  [[ $status -eq 42 ]]
}

# --- Direct execution guard ---

@test "direct execution prints usage error" {
  run bash "./scripts/lib/_retry.bash"

  [[ $status -eq 1 ]]
  [[ $output == *"This is a library file"* ]]
  [[ $output == *"source"* ]]
}
