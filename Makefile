# Development tasks for the MACH repository itself.
.PHONY: test test-serial validate check

test: ## Run every test suite, one process per test class, one worker per core
	python3 tests/in_parallel.py

test-serial: ## Run every test suite in one process
	python3 -m unittest discover -s tests

validate: ## Validate the plugin and marketplace manifests
	claude plugin validate .

check: test validate
