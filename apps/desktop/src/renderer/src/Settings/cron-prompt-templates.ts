/**
 * Cron prompt template library.
 *
 * Organised by category so the picker can render them grouped.
 * Each template carries:
 *   - title      : short label shown in the card
 *   - emoji      : visual anchor for quick scanning
 *   - description: one-line tooltip / subtitle
 *   - prompt     : the full prompt text applied to draft.prompt
 *   - schedule   : suggested default cron expression
 *   - name       : auto-filled job name (overrideable by user)
 */

export interface PromptTemplate {
  id: string;
  category: string;
  emoji: string;
  title: string;
  description: string;
  prompt: string;
  schedule: string;
  name: string;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  // ── Code Quality ──────────────────────────────────────────────────────────
  {
    id: 'code-review-daily',
    category: 'Code Quality',
    emoji: '🔍',
    title: 'Daily code review',
    description: 'Review recent git commits for issues and improvements',
    name: 'Daily code review',
    schedule: '0 9 * * 1-5',
    prompt:
      'Review all git commits made in the last 24 hours in this repository.\n' +
      'For each changed file:\n' +
      '1. Check for code smells, obvious bugs, and security issues\n' +
      '2. Suggest improvements to readability and maintainability\n' +
      '3. Flag any missing tests for new logic\n' +
      'Summarise findings in a concise markdown report and save it to .tday/review-{date}.md',
  },
  {
    id: 'lint-fix',
    category: 'Code Quality',
    emoji: '🧹',
    title: 'Auto lint & format',
    description: 'Run linter and auto-fix all fixable issues',
    name: 'Auto lint & format',
    schedule: '0 8 * * 1-5',
    prompt:
      'Run the project linter (eslint / prettier / ruff / gofmt — detect from package.json / pyproject.toml / go.mod) with auto-fix enabled.\n' +
      'After fixing, run the formatter.\n' +
      'If any issues remain that cannot be auto-fixed, list them clearly.\n' +
      'Do NOT commit the changes — leave them staged for review.',
  },
  {
    id: 'dead-code',
    category: 'Code Quality',
    emoji: '🗑️',
    title: 'Find dead code',
    description: 'Detect unused exports, variables, and dead branches weekly',
    name: 'Weekly dead code scan',
    schedule: '0 10 * * 1',
    prompt:
      'Scan the entire codebase for dead code:\n' +
      '- Unused exports and functions\n' +
      '- Variables declared but never read\n' +
      '- Unreachable branches (always-true/false conditions)\n' +
      '- TODO/FIXME comments older than 30 days (check git blame)\n' +
      'Output a markdown checklist grouped by file and save to .tday/dead-code-{date}.md',
  },
  {
    id: 'type-check',
    category: 'Code Quality',
    emoji: '📐',
    title: 'Type-check & report',
    description: 'Run tsc / mypy and summarise type errors',
    name: 'Type-check report',
    schedule: '0 9 * * 1-5',
    prompt:
      'Run the type checker for this project (tsc --noEmit for TypeScript, mypy for Python, etc.).\n' +
      'Parse the output and group errors by file.\n' +
      'For each error explain the likely root cause in plain English.\n' +
      'Save the report to .tday/typecheck-{date}.md',
  },

  // ── Testing ───────────────────────────────────────────────────────────────
  {
    id: 'test-run',
    category: 'Testing',
    emoji: '✅',
    title: 'Run test suite',
    description: 'Execute all tests and report failures',
    name: 'Daily test run',
    schedule: '0 7 * * 1-5',
    prompt:
      'Run the full test suite for this project.\n' +
      'Detect the test runner from package.json / pyproject.toml / Cargo.toml.\n' +
      'If tests fail:\n' +
      '  - Show the failing test names and error messages\n' +
      '  - Propose minimal fixes for each failure\n' +
      'If all tests pass, print a one-line summary with total count and duration.',
  },
  {
    id: 'coverage-report',
    category: 'Testing',
    emoji: '📊',
    title: 'Coverage report',
    description: 'Generate test coverage and flag uncovered critical paths',
    name: 'Weekly coverage report',
    schedule: '0 9 * * 1',
    prompt:
      'Run tests with coverage enabled and generate a coverage report.\n' +
      'Identify the 10 files with the lowest coverage that contain business-critical logic.\n' +
      'For each, write 2–3 suggested test cases (in code) that would meaningfully increase coverage.\n' +
      'Save the report to .tday/coverage-{date}.md',
  },
  {
    id: 'flaky-tests',
    category: 'Testing',
    emoji: '🎲',
    title: 'Detect flaky tests',
    description: 'Run tests 3× and report non-deterministic failures',
    name: 'Flaky test detector',
    schedule: '0 2 * * 6',
    prompt:
      'Run the test suite three times in a row.\n' +
      'Compare results across all three runs.\n' +
      'Any test that passes in some runs and fails in others is flaky.\n' +
      'List all flaky tests with their failure messages and suggest likely causes (async timing, shared state, env dependency).\n' +
      'Save findings to .tday/flaky-tests-{date}.md',
  },

  // ── Documentation ─────────────────────────────────────────────────────────
  {
    id: 'changelog',
    category: 'Documentation',
    emoji: '📝',
    title: 'Generate changelog',
    description: 'Summarise weekly git commits into a changelog entry',
    name: 'Weekly changelog',
    schedule: '0 18 * * 5',
    prompt:
      'Read all git commits from the past 7 days.\n' +
      'Group them into: Features, Bug Fixes, Refactors, Chores.\n' +
      'Write a human-readable CHANGELOG entry in Keep-a-Changelog format.\n' +
      'Prepend the entry to CHANGELOG.md (create if missing).\n' +
      'Do not commit — leave for the developer to review.',
  },
  {
    id: 'readme-sync',
    category: 'Documentation',
    emoji: '📖',
    title: 'Sync README',
    description: 'Keep README in sync with actual code structure',
    name: 'README sync',
    schedule: '0 10 * * 1',
    prompt:
      'Compare the current README.md with the actual project structure and code.\n' +
      'Identify sections that are outdated, missing, or inaccurate:\n' +
      '- Installation steps\n' +
      '- API / CLI usage examples\n' +
      '- Environment variables\n' +
      '- Architecture overview\n' +
      'Update README.md in place. Keep the existing tone and style.',
  },
  {
    id: 'api-docs',
    category: 'Documentation',
    emoji: '📡',
    title: 'API doc coverage',
    description: 'Find public APIs lacking JSDoc / docstrings',
    name: 'API doc coverage',
    schedule: '0 11 * * 3',
    prompt:
      'Scan all public functions, classes, and exported types in this codebase.\n' +
      'Find those that lack documentation (JSDoc, docstrings, or comments).\n' +
      'For the top-20 most-used undocumented symbols, write concise documentation and apply it to the source files.',
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'dep-audit',
    category: 'Security',
    emoji: '🔒',
    title: 'Dependency audit',
    description: 'Check for known vulnerabilities in dependencies',
    name: 'Dependency audit',
    schedule: '0 9 * * 1',
    prompt:
      'Run the dependency vulnerability scanner for this project (npm audit / pip-audit / cargo audit).\n' +
      'For each vulnerability found:\n' +
      '  - Severity level\n' +
      '  - Affected package and version\n' +
      '  - Recommended fix (upgrade path or workaround)\n' +
      'Fix all HIGH and CRITICAL vulnerabilities automatically if a safe upgrade exists.\n' +
      'Save a summary to .tday/security-audit-{date}.md',
  },
  {
    id: 'secret-scan',
    category: 'Security',
    emoji: '🕵️',
    title: 'Secret scanner',
    description: 'Detect accidentally committed secrets and credentials',
    name: 'Secret scan',
    schedule: '0 8 * * 1-5',
    prompt:
      'Scan the entire git history and working tree for accidentally committed secrets:\n' +
      '- API keys, tokens, passwords\n' +
      '- Private keys and certificates\n' +
      '- Connection strings with credentials\n' +
      'For each finding, report the file, line, and commit hash.\n' +
      'Do NOT print the actual secret value — redact it.\n' +
      'Save the report to .tday/secret-scan-{date}.md',
  },

  // ── Performance ───────────────────────────────────────────────────────────
  {
    id: 'bundle-size',
    category: 'Performance',
    emoji: '📦',
    title: 'Bundle size check',
    description: 'Monitor JS bundle size and flag regressions',
    name: 'Bundle size monitor',
    schedule: '0 9 * * 1-5',
    prompt:
      'Build the project in production mode and analyse the output bundle.\n' +
      'Compare the total bundle size against the last recorded size in .tday/bundle-baseline.json.\n' +
      'If any chunk grew by more than 5%, identify which dependencies caused the increase.\n' +
      'Update the baseline file and save a report to .tday/bundle-{date}.md',
  },
  {
    id: 'perf-benchmark',
    category: 'Performance',
    emoji: '⚡',
    title: 'Run benchmarks',
    description: 'Execute performance benchmarks and track regressions',
    name: 'Weekly benchmarks',
    schedule: '0 3 * * 6',
    prompt:
      'Run all performance benchmarks in this project (detect from package.json scripts or bench/ directory).\n' +
      'Compare results with the last stored baseline in .tday/bench-baseline.json.\n' +
      'Flag any metric that regressed by more than 10%.\n' +
      'Update the baseline and save a report to .tday/bench-{date}.md',
  },

  // ── Maintenance ───────────────────────────────────────────────────────────
  {
    id: 'dep-update',
    category: 'Maintenance',
    emoji: '⬆️',
    title: 'Update dependencies',
    description: 'Upgrade outdated packages to latest compatible versions',
    name: 'Dependency updates',
    schedule: '0 10 * * 1',
    prompt:
      'Check for outdated dependencies in this project.\n' +
      'Upgrade all packages to their latest MINOR or PATCH version (do NOT upgrade major versions automatically).\n' +
      'After upgrading, run the test suite.\n' +
      'If tests pass, leave the changes staged.\n' +
      'If tests fail, revert the upgrade for the breaking package and document it.',
  },
  {
    id: 'git-cleanup',
    category: 'Maintenance',
    emoji: '🌿',
    title: 'Stale branch cleanup',
    description: 'List merged and stale remote branches for cleanup',
    name: 'Stale branch report',
    schedule: '0 10 * * 1',
    prompt:
      'List all remote git branches that:\n' +
      '1. Have been merged into main/master\n' +
      '2. Have had no commits in the last 30 days\n' +
      'For each, show the last author, last commit date, and whether it is fully merged.\n' +
      'Do NOT delete any branches — only generate the list.\n' +
      'Save to .tday/stale-branches-{date}.md',
  },
  {
    id: 'todo-tracker',
    category: 'Maintenance',
    emoji: '📌',
    title: 'TODO tracker',
    description: 'Collect and prioritise all TODO/FIXME comments',
    name: 'TODO tracker',
    schedule: '0 9 * * 1',
    prompt:
      'Scan the entire codebase for TODO, FIXME, HACK, and XXX comments.\n' +
      'Use git blame to find the author and date of each.\n' +
      'Group them by age: < 1 week, 1–4 weeks, > 1 month.\n' +
      'For the 5 oldest TODOs, propose a concrete resolution.\n' +
      'Save the full list to .tday/todos-{date}.md',
  },

  // ── Project Management ────────────────────────────────────────────────────
  {
    id: 'standup',
    category: 'Project Management',
    emoji: '🗓️',
    title: 'Daily standup summary',
    description: 'Summarise yesterday\'s commits as a standup update',
    name: 'Daily standup',
    schedule: '0 9 * * 1-5',
    prompt:
      'Look at all git commits from the past 24 hours across all branches.\n' +
      'Write a concise daily standup update in this format:\n' +
      '**Yesterday:** What was completed (from commit messages)\n' +
      '**Today:** Logical next steps based on recent work\n' +
      '**Blockers:** Any TODO/FIXME comments added yesterday\n' +
      'Keep it under 200 words. Save to .tday/standup-{date}.md',
  },
  {
    id: 'sprint-report',
    category: 'Project Management',
    emoji: '🏃',
    title: 'Weekly sprint report',
    description: 'Generate a weekly progress summary from git activity',
    name: 'Weekly sprint report',
    schedule: '0 18 * * 5',
    prompt:
      'Analyse all git activity from the past 7 days.\n' +
      'Generate a sprint report covering:\n' +
      '- Features shipped (new files / new exports)\n' +
      '- Bugs fixed (commits mentioning fix/bug/patch)\n' +
      '- Technical debt addressed (refactor commits)\n' +
      '- Test coverage trend (if test files changed)\n' +
      '- Top contributors by commit count\n' +
      'Format as a concise markdown report and save to .tday/sprint-{date}.md',
  },
  {
    id: 'tech-debt',
    category: 'Project Management',
    emoji: '💳',
    title: 'Tech debt report',
    description: 'Quantify and prioritise technical debt monthly',
    name: 'Monthly tech debt report',
    schedule: '0 10 1 * *',
    prompt:
      'Analyse the codebase for technical debt indicators:\n' +
      '1. Files > 500 lines (complexity risk)\n' +
      '2. Functions > 50 lines or cyclomatic complexity > 10\n' +
      '3. Duplicated code blocks (> 20 lines repeated)\n' +
      '4. Missing error handling in async functions\n' +
      '5. Hardcoded magic numbers / strings\n' +
      'Score each item by impact and effort to fix.\n' +
      'Produce a prioritised action plan and save to .tday/tech-debt-{date}.md',
  },

  // ── Data & Analysis ───────────────────────────────────────────────────────
  {
    id: 'log-analysis',
    category: 'Data & Analysis',
    emoji: '🔬',
    title: 'Log analysis',
    description: 'Analyse application logs for errors and anomalies',
    name: 'Daily log analysis',
    schedule: '0 7 * * *',
    prompt:
      'Read the application logs from the last 24 hours (check logs/, *.log, or journalctl output).\n' +
      'Identify:\n' +
      '- ERROR and CRITICAL level messages\n' +
      '- Repeated warnings (> 10 occurrences)\n' +
      '- Unusual spikes in request latency or error rate\n' +
      'Group by error type and suggest root causes.\n' +
      'Save a digest to .tday/log-analysis-{date}.md',
  },
  {
    id: 'db-health',
    category: 'Data & Analysis',
    emoji: '🗄️',
    title: 'Database health check',
    description: 'Check schema drift, slow queries, and index usage',
    name: 'DB health check',
    schedule: '0 6 * * 1',
    prompt:
      'Connect to the project database (read credentials from .env / config files).\n' +
      'Run health checks:\n' +
      '1. List tables with no indexes on foreign keys\n' +
      '2. Find queries in the slow query log (if available)\n' +
      '3. Check for tables with > 1M rows that lack pagination-friendly indexes\n' +
      '4. Report any schema migrations pending\n' +
      'Save findings to .tday/db-health-{date}.md',
  },
];

/** All unique category names in display order. */
export const TEMPLATE_CATEGORIES = Array.from(
  new Set(PROMPT_TEMPLATES.map((t) => t.category)),
);
