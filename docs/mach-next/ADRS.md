# MACH Next — Decisions Locked for Experiment

- **ADR-001** Three experiences: Product Studio, Factory, Control Tower. They share one project model; no hosted control plane.
- **ADR-002** Local-first, SCM-native product artifacts; GitHub/GHEC collaboration permitted over outbound connections; no remote MACH listeners.
- **ADR-003** PMs and engineers are capabilities, not permanently separated accounts. The same person may use all three components.
- **ADR-004** Product Studio React SPA + native Go localhost service; `/mach:product-studio` is the full-featured terminal entry. Keep existing skills accessible.
- **ADR-005** Approved product work is delivered iteratively through `delivery-waves`; each contains approved, versioned, addressable slices.
- **ADR-006** Multiple PMs synchronize and publish via a managed workflow; show semantic product changes rather than Git concepts; respect enterprise PR policies.
- **ADR-007** Existing MACH Python station validators and Dynamic Workflows stay authoritative; don't duplicate or weaken them.
- **ADR-008** `/mach:run factory enable|disable|status|pause|resume` controls an **internal** supervisor, initially off on every machine. Do not introduce another user-facing `mach` CLI.
- **ADR-009** Hooks notify only. Supervisor reconciles persisted approved state and is policy-gated before every dispatch.
- **ADR-010** Default to one designated engineer runner per project; distributed multi-runner scheduling and portfolio support are deferred.
- **ADR-011** Control Tower is an optional, immersive React observability view with native Go collector; no operational dependency on the UI.
- **ADR-012** Versioned `.machpkg` handoffs remain a fallback. Primary collaboration is through the shared Git repository.
- **ADR-013** No Go/WASM/single-HTML build. Production SPA assets embedded in native local launcher.
- **ADR-014** A merged wave makes work *eligible for intake*, not automatically approved for privileged operations or deployment. MACHINE ENABLEMENT + runtime preflight + existing MACH gates are still required.
- **ADR-015** Maintain source-of-truth split: tracked product work orders vs gitignored ephemeral execution tickets/transcripts/worktrees; local authorization never synced.
