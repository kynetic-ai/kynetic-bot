---
name: local-review
description: Pre-PR quality review - verify AC coverage, test quality, and test isolation.
---

# Local Review

Quality enforcement for pre-PR review. Use before creating a PR to catch issues early.

## Quick Start

```bash
# Start the workflow
kspec workflow start @local-review
kspec workflow next --input spec_ref="@spec-slug"
```

## When to Use

- Before creating a PR
- When spawning a review subagent
- After completing implementation, before shipping

## Workflow Overview

5-step quality gate with strict checks:

1. **Get Spec & ACs** - Read acceptance criteria
2. **AC Coverage** - Every AC must have test (MUST-FIX)
3. **Test Quality** - No fluff tests (MUST-FIX)
4. **Test Isolation** - Tests properly isolated (MUST-FIX)
5. **Report** - List all blocking issues

## Review Criteria

### 1. AC Coverage (MUST-FIX)

Every acceptance criterion MUST have at least one test that validates it.

**How to check:**

```bash
# Find AC annotations in tests
grep -r "// AC: @spec-ref" tests/

# Compare against spec ACs
kspec item get @spec-ref
```

**Annotation format:**

```typescript
// AC: @spec-ref ac-1
it('should validate input when given invalid data', () => {
  // Test implementation
});
```

Missing AC coverage is a **blocking issue**, not a suggestion.

### 2. Test Quality (MUST-FIX)

All tests must properly validate their intended purpose.

**Valid tests:**

- AC-specific tests that validate acceptance criteria
- Edge case tests that catch real bugs
- Integration tests that verify components work together

**Fluff tests to reject:**

- Tests that always pass regardless of implementation
- Tests that only verify implementation details
- Tests that mock everything and verify nothing

**Litmus test:** Would this test fail if the feature breaks?

### 3. Test Isolation (MUST-FIX)

All tests MUST be properly isolated:

**Why this matters:**

- Prevents test pollution (one test affecting another)
- Ensures tests are reproducible
- Prevents data corruption in actual application state

**Correct patterns:**

```typescript
let mockStore: ConversationStore;

beforeEach(() => {
  mockStore = new InMemoryConversationStore();
  // Fresh state for each test
});

afterEach(() => {
  // Cleanup if needed
});
```

**Wrong patterns:**

```typescript
// NEVER do this - shared state across tests
const globalStore = new ConversationStore();

it('should work', () => {
  globalStore.add(...);  // Pollutes other tests!
});
```

## Issue Severity

| Issue               | Severity | Action               |
| ------------------- | -------- | -------------------- |
| Missing AC coverage | MUST-FIX | Add tests before PR  |
| Fluff test          | MUST-FIX | Rewrite or remove    |
| Tests not isolated  | MUST-FIX | Fix isolation issues |

## Report Format

Generate a summary with:

```markdown
## Local Review Summary

### AC Coverage

- [x] ac-1: Covered by test X
- [ ] ac-2: MISSING - no test found
- [x] ac-3: Covered by test Y

### Issues Found

1. **MUST-FIX**: Missing coverage for ac-2
2. **MUST-FIX**: Test Z is fluff (always passes)

### Verdict

- [ ] Ready for PR (all checks pass)
- [x] Needs fixes (MUST-FIX issues above)
```

## Integration

- **After task work**: Run local review before `/pr`
- **Before merge**: Complements `@pr-review-merge` workflow
- **In CI**: Automated review also runs but local catches issues earlier
