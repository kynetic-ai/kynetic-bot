#!/bin/bash
# git-sanity.sh - Check for git config pollution from test isolation failures
#
# Detects:
# - core.bare=true (bare repo corruption)
# - user.name=Test (test config pollution)
# - user.email=test@test.com (test config pollution)

set -e

errors=0

# Check for bare repo corruption
if git config --get core.bare 2>/dev/null | grep -qi "^true$"; then
  echo "ERROR: Repository is set to bare mode (core.bare=true)"
  echo "This is likely test pollution. Fix with: git config core.bare false"
  errors=$((errors + 1))
fi

# Check for test user.name pollution (case-insensitive, anchored)
if git config --get user.name 2>/dev/null | grep -qi "^test$"; then
  echo "ERROR: Test user.name detected in git config"
  echo "Fix with: git config --unset user.name"
  errors=$((errors + 1))
fi

# Check for test user.email pollution (case-insensitive, anchored)
if git config --get user.email 2>/dev/null | grep -qi "^test@test\.com$"; then
  echo "ERROR: Test user.email detected in git config"
  echo "Fix with: git config --unset user.email"
  errors=$((errors + 1))
fi

if [ $errors -gt 0 ]; then
  exit 1
fi
