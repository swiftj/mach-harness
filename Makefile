# Development tasks for the MACH repository itself. `make help` lists them.
.PHONY: help test test-changed test-serial validate check

help: ## List these tasks
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

test: ## Run every test suite, one process per test class, one worker per core (run before a merge)
	python3 tests/in_parallel.py

test-changed: ## Run only the test classes this branch's changes can affect (says when that is all of them)
	python3 tests/affected.py

test-serial: ## Run every test suite in one process
	python3 -m unittest discover -s tests

validate: ## Validate the plugin and marketplace manifests
	claude plugin validate .

check: test validate
