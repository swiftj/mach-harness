# MACH factory targets. Managed by MACH: reinstalling replaces this file.
# Put your own targets in the project's Makefile, which includes this one.

MACH := python3 .factory/bin/mach

.PHONY: mach-status mach-cells mach-uninstall

mach-status: ## Show what MACH installed, what you changed, and the open cells
	@$(MACH) status

mach-cells: ## List the git worktrees behind the open cells
	@git worktree list

mach-uninstall: ## Remove MACH from this project (tickets, specs and cells are kept)
	@$(MACH) uninstall
