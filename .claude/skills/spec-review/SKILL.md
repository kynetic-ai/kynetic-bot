---
name: spec-review
description: Verify spec implementation and find gaps using automated verification
---

# Spec Review

Automated verification workflow that runs after spec implementation to verify completeness and find gaps.

## When to Use

- After implementing a spec to verify all AC are covered
- When you want to find gaps between spec and implementation
- As part of PR review to ensure spec alignment
- When troubleshooting missing functionality

## Quick Start

```bash
# Review a specific spec implementation
/spec-review @spec-slug
```

## What This Does

The spec-review skill automates the "run two subagents to verify implementation" pattern:

1. **Verification Subagent**: Checks each acceptance criterion has implementation + tests
2. **Gap Analysis Subagent**: Identifies missing functionality, edge cases, or incomplete tests

## Workflow Overview

### 1. Read the Spec

First, understand what should be implemented:

```bash
kspec item get @spec-slug
```

Review:

- Title and description
- All acceptance criteria
- Implementation status
- Related tasks

### 2. Find Implementation Files

Locate the actual implementation:

```bash
# Search for the spec reference in code
grep -r "@spec-slug" src/

# Find AC annotations
grep -r "// AC: @spec-slug" tests/
```

### 3. Spawn Verification Subagent

Launch a general-purpose subagent to verify each AC:

**Prompt for verification subagent:**

```
Review implementation for spec @spec-slug.

For each acceptance criterion:
1. Find the implementation code that satisfies it
2. Find the test(s) with AC annotation (// AC: @spec-slug ac-N)
3. Verify test actually validates the AC behavior

Report:
- Each AC: COVERED (with file:line) or MISSING
- Any tests that exist but don't properly validate
- Any implementation without tests

Focus on factual coverage, not code quality.
```

### 4. Spawn Gap Analysis Subagent

Launch a second subagent to find what's missing:

**Prompt for gap analysis subagent:**

```
Find gaps in implementation for spec @spec-slug.

Compare spec acceptance criteria against actual implementation.

Look for:
1. Edge cases mentioned in spec but not tested
2. Error handling paths not covered
3. AC that are partially implemented
4. Functionality that works but lacks verification
5. Tests that exist but don't match AC intent

Report specific gaps with:
- What's missing (concrete, specific)
- Why it matters (from spec perspective)
- Where to add it (file/function)

Don't report stylistic issues or suggest enhancements beyond the spec.
```

### 5. Consolidate Results

After both subagents complete, synthesize findings:

```markdown
## Spec Review: @spec-slug

### Verification Results

**AC Coverage:**

- [x] ac-1: Covered (src/file.ts:45, test/file.test.ts:12)
- [ ] ac-2: MISSING - no test found
- [x] ac-3: Covered (src/file.ts:78, test/file.test.ts:34)

**Test Quality Issues:**

- test/file.test.ts:56 - Test always passes, doesn't verify behavior

### Gap Analysis

**Missing Functionality:**

1. Error handling for invalid input (ac-2) - No validation in src/file.ts:handleInput()
2. Edge case: empty array (ac-3) - Test only covers non-empty case

**Partially Implemented:**

- ac-4: Basic functionality exists but missing timeout behavior from spec

### Summary

**Status:** NEEDS FIXES

**Required Actions:**

1. Add test for ac-2 with proper validation
2. Fix test at line 56 to verify actual behavior
3. Add edge case test for empty array
4. Implement timeout behavior for ac-4

**Estimated Scope:** 2-3 small fixes, no major refactoring needed
```

## Integration with Other Skills

- **After `/task-work`**: Run spec-review before creating PR
- **Before `/pr`**: Catch gaps early, before code review
- **With `/local-review`**: Complements local-review (that focuses on test quality)
- **During PR review**: Verify spec alignment holistically

## Subagent Configuration

Use these settings when spawning subagents:

**Verification Subagent:**

- Type: `general-purpose` (needs search + read capabilities)
- Model: `haiku` (straightforward verification task)
- Run mode: Can run in parallel with gap analysis

**Gap Analysis Subagent:**

- Type: `general-purpose` (needs deeper analysis)
- Model: `sonnet` (requires reasoning about completeness)
- Run mode: Can run in parallel with verification

## When NOT to Use

Skip spec-review when:

- No spec exists (use `/local-review` for test quality instead)
- Implementation is a work-in-progress (wait until code-complete)
- Doing exploratory work or prototyping

## Common Issues

**"Can't find implementation"**

- Search by task ref: `grep -r "@task-slug" src/`
- Check recent commits: `git log --oneline --grep="spec-slug"`
- Implementation may be in PR, not yet merged

**"Spec has no AC"**

- Can't run verification without acceptance criteria
- Add AC first: `kspec item ac add @spec-slug --given "..." --when "..." --then "..."`

**"Too many gaps reported"**

- Filter to spec-defined requirements only
- Ignore enhancement suggestions beyond spec scope
- Focus on AC coverage, not code quality

## Example Output

After running both subagents, you should have:

1. **Verification Report**: Factual AC coverage status
2. **Gap Analysis**: Specific missing pieces with locations
3. **Consolidated Summary**: Action items to achieve full spec alignment

## Quick Reference

```bash
# Full workflow in one block
kspec item get @spec-slug                    # Read spec
grep -r "@spec-slug" src/ tests/             # Find implementation
# Spawn verification subagent (see prompt above)
# Spawn gap analysis subagent (see prompt above)
# Consolidate results into summary
```
