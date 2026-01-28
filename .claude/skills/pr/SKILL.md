---
name: pr
description: Create a pull request from current work. Handles branch creation, commits, push, and PR creation.
---

# PR Skill

Create pull requests from current work.

## Quick Start

```bash
# Create PR from current work
/pr
```

## When to Use

- After completing work that needs to be merged via PR
- When direct push to main is blocked by branch protection
- To ship changes in a reviewable format

## Workflow

### Step 1: Detect Context

```bash
# Get current branch
git branch --show-current

# Check for uncommitted changes
git status --porcelain

# Check remote
git remote get-url origin
```

### Step 2: Determine Branch Strategy

**Branch name auto-generation - just do it, don't ask:**

1. If there's a completed/in-progress kspec task: use `fix/<task-slug>` or `feat/<task-slug>`
2. If recent commits have conventional format: derive from commit message
3. If unpushed commits exist: summarize their intent

**If on `main` with uncommitted changes:**
1. Auto-generate branch name
2. Create branch: `git checkout -b <branch-name>`
3. Stage and commit changes
4. Push with `-u origin <branch-name>`

**If on `main` with committed but unpushed changes:**
1. Auto-generate branch name from commit messages
2. Create branch from current HEAD: `git checkout -b <branch-name>`
3. Reset main to origin/main
4. Push branch

**If already on feature branch:**
1. Commit any uncommitted changes
2. Push to origin

### Step 3: Create PR

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<bullet points>

## Test plan
<checklist>

Task: @<task-ref>
Spec: @<spec-ref>

Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

**Title generation:**
- If linked to kspec task: Use task title
- If conventional commit in last commit: Use that
- Otherwise: Ask user

**Body generation:**
- Summarize changes from `git diff main...HEAD`
- Include task/spec references if available
- Add test plan checklist

### Step 4: Report

Display:
- PR URL
- Branch name
- Summary of what was included

## After PR Creation

Once the PR is created, follow the `@pr-review-merge` workflow for the review-to-merge cycle:

1. Wait for all CI checks to complete and pass
2. Address any review feedback
3. Ensure all review threads are resolved
4. Merge when all gates are green

The workflow is defined in `.kspec/kynetic-bot.meta.yaml` and can be invoked with:
```bash
kspec workflow start @pr-review-merge
```

## Merge Strategy

Use merge commits (not squash) to preserve kspec trailers:
- `Task: @task-slug`
- `Spec: @spec-ref`

These enable `kspec log @ref` to find related commits.

## Integration with kspec

**Before creating PR:**
```bash
# Check for in-progress tasks
kspec tasks in-progress
```

If in-progress task found:
- Suggest branch name based on task slug
- Include task reference in PR body
- Remind to complete task after merge

**Suggested commit format:**
```
<type>: <description>

Task: @<task-slug>
Spec: @<spec-ref>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## Branch Naming

Auto-generate names based on context (in priority order):
1. **From kspec task**: `fix/<task-slug>` or `feat/<task-slug>` based on task type
2. **From commit message**: Parse conventional commit prefix and description
3. **From diff summary**: Derive from changed files/functionality

## Error Handling

**No remote configured:**
```
Error: No git remote configured. Add one with:
  git remote add origin <url>
```

**PR already exists:**
```bash
gh pr list --head <branch> --json number,url
```
If exists, show URL instead of creating new.
