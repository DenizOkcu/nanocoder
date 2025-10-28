# Planning Workflow Commands

Four-phase workflow for systematic feature development: Research → Design → Implement → Review.

## Quick Start

```bash
/plan:research "Add JWT authentication"  # Start: research + generate issue name → "jwt-authentication"
/plan:design jwt-authentication          # Create implementation plan and specs
/plan:implement jwt-authentication       # Execute the plan systematically
/plan:review jwt-authentication          # Run checks and review code
```

All artifacts stored in `.nanocoder/planning/{{issue-name}}/`. Each command updates `STATUS.md` to track progress.

---

## Commands

### 1. `/plan:research {feature-description}`

**Starts a new feature.** Takes natural description, generates issue name, researches codebase.

```bash
/plan:research Add JWT authentication with refresh tokens
# Generates: jwt-authentication
# Creates: .nanocoder/planning/jwt-authentication/CODE_RESEARCH.md
# Creates: .nanocoder/planning/jwt-authentication/STATUS.md
```

**Output:**
- Generates issue name (e.g., `jwt-authentication`)
- `CODE_RESEARCH.md` - Architecture, patterns, integration points, risks
- `STATUS.md` - Progress tracker

**Next:** `/plan:design jwt-authentication`

---

### 2. `/plan:design {{issue-name}}`

**Creates implementation plan.** Reads research, designs architecture, plans phases.

```bash
/plan:design jwt-authentication
```

**Output:**
- `IMPLEMENTATION_PLAN.md` - Phased tasks with file paths
- `PROJECT_SPEC.md` - Technical design, types, error handling

**Next:** `/plan:implement jwt-authentication`

---

### 3. `/plan:implement {{issue-name}}`

**Executes the plan.** Implements code phase-by-phase, writes tests, tracks with todos.

```bash
/plan:implement jwt-authentication
```

**Output:**
- Implementation code
- Tests
- Updates `STATUS.md`

**Next:** `/plan:review jwt-authentication`

---

### 4. `/plan:review {{issue-name}}`

**Quality assurance.** Runs linting, types, tests, build. Manual code review. Security check.

```bash
/plan:review jwt-authentication
```

**Output:**
- `CODE_REVIEW.md` - Findings, issues, approval status
- Updates `STATUS.md` with APPROVED/NEEDS REVISION

**Next:** Deploy or fix issues

---

## Complete Example

```bash
# 1. Research (natural description)
/plan:research Add JWT authentication with refresh tokens

# Output: Generated issue name: jwt-authentication
# Creates: CODE_RESEARCH.md, STATUS.md

# 2. Design
/plan:design jwt-authentication
# Creates: IMPLEMENTATION_PLAN.md, PROJECT_SPEC.md

# 3. Implement
/plan:implement jwt-authentication
# Creates code + tests, updates STATUS.md

# 4. Review
/plan:review jwt-authentication
# Creates: CODE_REVIEW.md
# STATUS.md shows: ✓ APPROVED or ⚠ NEEDS REVISION

# 5. Deploy
git add .
git commit -m "feat: add JWT authentication with refresh tokens"
git push
```

---

## File Organization

```
.nanocoder/planning/
└── jwt-authentication/
    ├── CODE_RESEARCH.md        # Architecture analysis
    ├── IMPLEMENTATION_PLAN.md  # Phased tasks
    ├── PROJECT_SPEC.md         # Technical design
    ├── CODE_REVIEW.md          # Review findings
    └── STATUS.md               # Progress tracker
```

---

## STATUS.md - Progress Tracker

All commands update this file automatically. Shows:
- Current phase and progress
- Key findings from each phase
- Next recommended command
- All artifacts created

**Example:**

```markdown
# Development Status

**Issue Name:** `jwt-authentication`
**Feature:** Add JWT authentication with refresh tokens
**Started:** 2025-10-28

## Progress

- [x] Research
- [x] Design
- [x] Implementation (8 files, 23 tests passing)
- [x] Review - ✓ APPROVED

## Next

Ready to deploy
```

---

## Issue Name Generation

`/plan:research` automatically generates kebab-case names:

| Description                                | Generated Name       |
| ------------------------------------------ | -------------------- |
| Add JWT authentication with refresh tokens | `jwt-authentication` |
| Fix memory leak in WebSocket connections   | `fix-memory-leak`    |
| Implement user dashboard with analytics    | `user-dashboard`     |

---

## Tips

**When to use:**
- Complex/unfamiliar features → Full workflow (research → design → implement → review)
- Medium complexity → Skip research, start with `/plan:design`
- Simple changes → Code directly, skip workflow

**Multiple features:**
Each gets its own directory. Work on them independently:
```bash
/plan:research Add JWT authentication       # → jwt-authentication/
/plan:research Add user dashboard           # → user-dashboard/
/plan:design jwt-authentication             # Work independently
/plan:design user-dashboard
```

**Check progress anytime:**
```bash
cat .nanocoder/planning/jwt-authentication/STATUS.md
```

**Iterate at any phase:**
```bash
/plan:design jwt-authentication     # Update plans
/plan:implement jwt-authentication  # Re-implement
/plan:review jwt-authentication     # Re-verify
```

---

## Benefits

✅ **Structured** - Clear phases prevent getting lost
✅ **Discoverable** - Type `/plan:` to see all commands
✅ **Transparent** - STATUS.md tracks complete workflow state
✅ **Resumable** - Come back anytime, STATUS.md shows where you are
✅ **Quality** - Built-in review and testing phase
✅ **Simple** - First step takes natural language description

---

## Other Commands

### `/typescript-pro {description}`

TypeScript expert for advanced patterns. Located in `language/typescript-pro.md`.

```bash
/typescript-pro Design a type-safe event system with typed handlers
```

Use for: Complex types, generics, strict type safety, advanced patterns.
