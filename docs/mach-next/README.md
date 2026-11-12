# MACH Next — Branch Foundation

Status: **experimental design + additive, non-dispatching contract prototype**

Suggested branch: `feature/mach-next-product-studio-supervisor`

This foundation intentionally adds no automatic execution to the existing MACH 0.11.x pipeline. It defines the three-layer target architecture, durable product contracts, and a Python 3.8+ structural validator suitable for integration with the existing deterministic MACH validation tools. Its tests exercise contract validation and the **disabled-by-default** machine policy.

## What is included now

- Architecture decision record and phased delivery plan, including explicit acceptance tests.
- Versioned, SCM-tracked product/epic/slice/delivery-wave schemas and a concrete sample project.
- Structural validator (`skills/product-studio/scripts/product.py`; it was the root `mach_product` package until M1): safe artifact paths, relationship integrity, revision sanity, approved-wave checks, dependency cycle detection, and SHA-256 content binding.
- Machine-local policy reader whose absent configuration **always evaluates to Factory disabled**.
- Regression tests using only the Python standard library.

## Deliberately *not* implemented yet

- Live Product Studio React UI, Claude Code interview integration, product PR publishing, GitHub sync, Dynamic Workflow dispatch, background supervisor, Control Tower, and a working `/mach:product-studio` skill.
- Full MACH slice semantic validation. The new validator checks *structural readiness only*. It cannot authorize Factory execution by itself. During integration it must invoke the existing `skills/intent/scripts/validate_slice.py` and any required `cell.py` gates; those gates remain authoritative.
- Any Git hook installation, auto-sync, remote listener, or automatic mutation of a user's checkout.

## How to test

Copy the package's contents to a **new feature branch** at the root of a clone of `swiftj/mach-harness` and run:

```bash
python3 -m unittest discover -s tests -p 'test_mach_product_*.py' -v
python3 skills/product-studio/scripts/product.py --project docs/mach-next/example-project --policy
```

The example is a structural fixture, **not** a factory-executable product specification. Expected result: structural validation passes with `factory_authorized: false`.

## Milestones built since

- **M1** terminal Product Studio: `M1_DESIGN.md`
- **M2** publishing and collaboration: `M2_DESIGN.md`
- **M3** Factory intake and dependency-aware scheduling: `M3_DESIGN.md`, with the event and ledger schemas in `schemas/`
- **M4** the Factory Supervisor, opt-in and machine-local: `M4_DESIGN.md`, with the runner policy schema in `schemas/`
- **M5** the visual Product Studio: `M5_DESIGN.md`, with the working contract in `M5_CONTRACT.md`, the design system in `DESIGN_SYSTEM.md` and the interview proof in `M5_INTERVIEW_POC.md`
- **M6.0** the Living Factory prototype (a simulation, shown for visual review before the Control Tower is built): the working contract in `M6_0_CONTRACT.md`, the visual, grammar and camera specification in `M6_0_VISUAL_SPEC.md`, the rendering architecture and its tradeoffs in `M6_0_ARCHITECTURE.md`, performance, accessibility and honesty findings in `M6_0_FINDINGS.md`, and what the Factory does not yet report in `M6_0_TELEMETRY_GAPS.md`

## Critical integration invariant

Product Studio publication/approval is distinct from (a) successful MACH `validate_slice.py` validation, (b) product-PR merge, and (c) the machine-specific authorization to autonomously execute. All four must be satisfied, plus existing Factory gates, before the Supervisor dispatches anything.

## Source alignment

The design is based on public MACH 0.11.1 (`README.md`, `CLAUDE.md`, `skills/run/SKILL.md`, `skills/run/scripts/run.py`, and `skills/intent/scripts/validate_slice.py`, reviewed November 10, 2026). Verify paths, signatures, installer behavior, tests, and any upstream changes against the real clone before merging.
