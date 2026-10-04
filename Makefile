# Agent Control Deck — desktop and reference bridge workflows
.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BRIDGE_DIR := $(ROOT)/bridge
UV_RUN = uv --directory "$(BRIDGE_DIR)" run

ADAPTERS ?= mock post
HOST ?= 127.0.0.1
PORT ?= 8787
HOST_NAME ?=
SERVE_FLAGS ?=
FROM_URL ?= http://$(HOST):$(PORT)/v1/status
ADAPTER_ARGS = $(foreach a,$(ADAPTERS),--adapter $(a))
HOST_NAME_ARG = $(if $(HOST_NAME),--host-name $(HOST_NAME),)

.PHONY: help check test status health bridge-install bridge-test bridge-serve bridge-serve-mock schema-check
help: ## Show available commands
	@echo "Agent Control Deck"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo 'Overrides: ADAPTERS="mock post", HOST=127.0.0.1, PORT=8787, HOST_NAME=..., SERVE_FLAGS=...'

check: bridge-test schema-check desktop-check ## Run desktop and reference bridge checks

test: bridge-test ## Run bridge tests

bridge-install: ## Install the bridge and dev dependencies with uv
	uv --directory "$(BRIDGE_DIR)" sync

bridge-test: ## Run the bridge pytest suite
	$(UV_RUN) pytest -q

bridge-serve: ## Serve hooks and sessions on loopback (mock + post by default)
	$(UV_RUN) acd-bridge serve --host "$(HOST)" --port $(PORT) $(ADAPTER_ARGS) $(HOST_NAME_ARG) $(SERVE_FLAGS)

bridge-serve-mock: ## Serve mock sessions
	$(MAKE) bridge-serve ADAPTERS=mock

status: ## Read a running bridge snapshot
	@curl --fail --silent --show-error "$(FROM_URL)" | (command -v jq >/dev/null && jq . || cat)

health: ## Check a running bridge
	@curl --fail --silent --show-error "http://$(HOST):$(PORT)/healthz"

# Keep both the canonical JSON Schema and existing Pydantic validation.
# The example byte budget is retained for v1 compatibility during migration.
define SCHEMA_CHECK_PY
import json, os, pathlib, sys
from jsonschema import Draft202012Validator
from agent_control_deck_bridge.model import StatusSnapshot
root = pathlib.Path(os.environ["SCHEMA_DIR"])
schema = json.loads((root / "status.schema.json").read_text())
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
errors = 0
for path in sorted((root / "examples").glob("*.json")):
    try:
        raw = path.read_bytes()
        data = json.loads(raw)
        validator.validate(data)
        StatusSnapshot.model_validate(data)
        if len(raw) > 8192:
            raise ValueError("exceeds retained 8192-byte example budget")
        print(f"ok   {path.name} ({len(raw)} bytes)")
    except Exception as exc:
        errors += 1
        print(f"FAIL {path.name}: {exc}")
sys.exit(1 if errors else 0)
endef
export SCHEMA_CHECK_PY

schema-check: ## Validate v1 examples against JSON Schema, models, and byte budget
	@SCHEMA_DIR="$(ROOT)/schema" $(UV_RUN) python -c "$$SCHEMA_CHECK_PY"

MAKEFLAGS += --no-print-directory

# Desktop app (Node 24+ / npm)
.PHONY: desktop-dev desktop-build desktop-test desktop-check desktop-package
desktop-dev: ## Start the Electron development app
	npm run dev

desktop-build: ## Type-check and build the desktop app
	npm run build

desktop-test: ## Run desktop persistence/provider tests
	npm test

desktop-check: ## Run all desktop checks, including Electron UI tests
	npm run check

desktop-package: ## Build an unpacked desktop app for this OS
	npm run package
