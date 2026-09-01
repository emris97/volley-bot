# Task 2 report: exact and rounded cost splitting

Worktree: `D:\Desktop\volley-bot\.worktrees\attendance-payments-hardening`

Branch: `codex/attendance-payments-hardening`

## TDD evidence

### RED

Requested command:

```text
pnpm vitest run packages/domain/src/payments/settlement.spec.ts packages/domain/src/payments/settlement.property.spec.ts
```

Result: exit 1 before Vitest started because the pnpm wrapper reported `'vitest' is not recognized as an internal or external command` in this worktree.

Equivalent local-binary command:

```text
& .\node_modules\.bin\vitest.cmd run packages/domain/src/payments/settlement.spec.ts packages/domain/src/payments/settlement.property.spec.ts
```

Result: exit 1 as expected. Both suites failed to import `./money.js`, with `Test Files 2 failed` and `Tests no tests`; the production modules were absent at this point.

### GREEN

Focused command:

```text
& .\node_modules\.bin\vitest.cmd run packages/domain/src/payments
```

Result: exit 0 — `Test Files 2 passed (2)`, `Tests 18 passed (18)`.

The focused command was rerun after formatting with the same result.

## Verification commands and results

```text
pnpm typecheck
```

Exit 0 (`tsc -b --pretty false`).

```text
pnpm lint
```

Exit 0 (`eslint .`).

```text
& .\node_modules\.bin\prettier.cmd --check packages/domain/src/payments/money.ts packages/domain/src/payments/settlement.ts packages/domain/src/payments/settlement.spec.ts packages/domain/src/payments/settlement.property.spec.ts packages/domain/src/index.ts
```

Exit 0; all changed files use Prettier style.

Required full test command:

```text
pnpm test
```

Exit 1. The domain and other non-container suites passed: `Test Files 36 passed`, `Tests 95 passed`, `Tests 19 skipped`. Eleven existing integration/e2e suites failed during setup with `Could not find a working container runtime strategy` because Docker/Testcontainers is unavailable in this environment.

## Changed files

- `packages/domain/src/payments/money.ts`: string-only RUB decimal parser producing bigint minor units.
- `packages/domain/src/payments/settlement.ts`: exact and upward-rounded settlement allocation.
- `packages/domain/src/payments/settlement.spec.ts`: example, validation, and parser tests.
- `packages/domain/src/payments/settlement.property.spec.ts`: fast-check invariants for totals, surplus, determinism, and bigint values.
- `packages/domain/src/index.ts`: public domain exports for money and settlement APIs.

## Self-review

- Exact allocation sorts participant IDs and gives the first sorted participants the deterministic minor-unit remainder.
- Upward modes first calculate integer `ceil(totalMinor / count)`, then round that share to 1, 10, or 50 major RUB units (100, 1,000, or 5,000 minor units), preserving nonnegative surplus for tiny positive totals.
- Decimal input accepts only nonnegative decimal strings with zero, one, or two fractional digits; invalid, negative, and over-precision values are rejected before parsing.
- Monetary arithmetic uses bigint throughout production code; no monetary value is converted through JavaScript number or floating-point arithmetic.
- Empty and duplicate participant sets are rejected, and existing `RoundingMode` exports remain compatible.

## Concerns

- The full repository test command cannot reach green until a Docker-compatible container runtime is available for the pre-existing integration/e2e suites.
- In this checkout, `pnpm vitest` and `pnpm exec prettier` could not resolve local binaries; equivalent commands invoking the checked-in `.cmd` binaries were used for focused tests and formatting verification.
