# Development tasks for the MACH repository itself.
.PHONY: test validate check

test: ## Run every test suite
	python3 -m unittest discover -s tests

validate: ## Validate the plugin and marketplace manifests
	claude plugin validate .

check: test validate
