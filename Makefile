# Agent Control Deck — monorepo task runner
#
#   make                 # list targets
#   make bridge-serve
#   make sim
#   make deck-flash
#
# Override knobs on the command line, e.g.:
#   make bridge-serve ADAPTERS="mock post"
#   make push-ble ONCE=1
#   make sim EXAMPLE=mock_3sessions.json SCALE=2
#   make sim-live POLL=1
#
# Bridge commands use uv (see bridge/README.md). Install: https://docs.astral.sh/uv/

.DEFAULT_GOAL := help
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT        := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BRIDGE_DIR  := $(ROOT)/bridge
DECK_DIR    := $(ROOT)/deck
SIM_DIR     := $(ROOT)/deck/sim
SCHEMA_DIR  := $(ROOT)/schema
TOOLS_DIR   := $(ROOT)/tools/ble_link

VENV        := $(BRIDGE_DIR)/.venv
SIM_BIN     := $(SIM_DIR)/build/acd-ui-sim

# uv --directory keeps env vars (e.g. SCHEMA_EXAMPLES=… uv --directory …) intact.
UV_RUN      = uv --directory "$(BRIDGE_DIR)" run
UV_TOOL     = uv --directory "$(TOOLS_DIR)" run --with-requirements requirements.txt

# --- overridable knobs -------------------------------------------------------
ADAPTERS    ?= mock post
HOST        ?= 127.0.0.1
PORT        ?= 8787
HOST_NAME   ?=
INTERVAL    ?= 15
ONCE        ?=
NAME        ?=
FROM_URL    ?= http://$(HOST):$(PORT)/v1/status
POLL        ?= 2
SCALE       ?= 1
EXAMPLE     ?= design_c_sessions.json
BMP         ?=
SIM_FLAGS   ?=
PUSH_FLAGS  ?=
SERVE_FLAGS ?=
PIO_ENV     ?= T5-ePaper
BUILD_TYPE  ?= Release

EXAMPLE_PATH := $(SCHEMA_DIR)/examples/$(EXAMPLE)

# Expand ADAPTERS="mock post" → --adapter mock --adapter post
ADAPTER_ARGS  = $(foreach a,$(ADAPTERS),--adapter $(a))
HOST_NAME_ARG = $(if $(HOST_NAME),--host-name $(HOST_NAME),)
ONCE_ARG      = $(if $(ONCE),--once,)
NAME_ARG      = $(if $(NAME),--name $(NAME),)
BMP_ARG       = $(if $(BMP),--bmp $(BMP),)
SCALE_ARG     = $(if $(filter-out 1,$(SCALE)),--scale $(SCALE),)

define require_uv
	@command -v uv >/dev/null || { \
	  echo "error: uv not found. Install: https://docs.astral.sh/uv/"; \
	  exit 1; \
	}
endef

define require_bridge
	$(call require_uv)
	@test -d "$(VENV)" || { \
	  echo "error: bridge env missing. Run: make bridge-install"; \
	  exit 1; \
	}
endef

define require_sim
	@test -x "$(SIM_BIN)" || { \
	  echo "error: UI sim not built. Run: make sim-build"; \
	  exit 1; \
	}
endef

# ============================================================================
# Help
# ============================================================================

.PHONY: help
help: ## Show this help
	@echo "Agent Control Deck"
	@echo ""
	@echo "Usage:  make <target> [VAR=value …]"
	@echo ""
	@awk 'BEGIN {FS = ":.*##"; section=""} \
	  /^# =+$$/ { next } \
	  /^# [A-Za-z].*$$/ { \
	    line=$$0; sub(/^# /,"",line); \
	    if (line !~ /^=/) section=line; next \
	  } \
	  /^[a-zA-Z0-9_.-]+:.*?##/ { \
	    if (section != prev) { \
	      if (prev != "") print ""; \
	      printf "\033[1m%s\033[0m\n", section; \
	      prev=section; \
	    } \
	    printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 \
	  }' $(MAKEFILE_LIST)
	@echo ""
	@echo "Common overrides:"
	@echo "  ADAPTERS=\"mock post\"   bridge adapters (default: mock post)"
	@echo "  EXAMPLE=mock_3sessions.json   schema example basename"
	@echo "  ONCE=1                 one-shot BLE push"
	@echo "  SCALE=2                sim pixel scale"
	@echo "  BMP=/tmp/deck.bmp      headless sim screenshot path"
	@echo "  NAME=ACD-A1B2          target a specific deck"
	@echo "  SERVE_FLAGS=…          extra flags for acd-bridge serve"
	@echo "  PUSH_FLAGS=…           extra flags for acd-bridge push-ble"
	@echo "  SCENARIO=builtin:lifecycle  scenario source for push-ble-scenario"
	@echo "  SIM_FLAGS=…            extra flags for acd-ui-sim (--stale, --no-link, …)"

# ============================================================================
# Meta / verify
# ============================================================================

.PHONY: check
check: bridge-test schema-check sim-build deck-build ## Run tests + schema check + firmware & sim builds

.PHONY: test
test: bridge-test ## Alias for bridge-test

.PHONY: status
status: ## GET /v1/status from a running bridge (needs curl)
	@curl -sS "$(FROM_URL)" | (command -v jq >/dev/null && jq . || cat)

.PHONY: health
health: ## GET /healthz from a running bridge
	@curl -sS "http://$(HOST):$(PORT)/healthz"; echo

# ============================================================================
# Bridge (Python / uv)
# ============================================================================

.PHONY: bridge-install
bridge-install: ## uv sync bridge env (editable package + dev group)
	$(call require_uv)
	uv --directory "$(BRIDGE_DIR)" sync
	@echo "✓ bridge ready (uv run acd-bridge …)"

.PHONY: bridge-test
bridge-test: ## Run bridge pytest suite
	$(call require_bridge)
	$(UV_RUN) pytest -q

.PHONY: bridge-serve
bridge-serve: ## Start loopback HTTP (hooks / Session API / GET /v1/status)
	$(call require_bridge)
	$(UV_RUN) acd-bridge serve \
	  --host "$(HOST)" \
	  --port $(PORT) \
	  $(ADAPTER_ARGS) \
	  $(HOST_NAME_ARG) \
	  $(SERVE_FLAGS)

.PHONY: bridge-serve-mock
bridge-serve-mock: ## Serve with mock adapter only
	$(MAKE) bridge-serve ADAPTERS=mock

.PHONY: push-ble
push-ble: ## BLE push loop (poll serve URL; ONCE=1 for one-shot)
	$(call require_bridge)
	$(UV_RUN) acd-bridge push-ble \
	  --from-url "$(FROM_URL)" \
	  --interval $(INTERVAL) \
	  $(ONCE_ARG) \
	  $(NAME_ARG) \
	  $(PUSH_FLAGS)

.PHONY: push-ble-once
push-ble-once: ## One-shot BLE push from running serve
	$(MAKE) push-ble ONCE=1

.PHONY: push-ble-mock
push-ble-mock: ## One-shot BLE push from local mock (no HTTP serve needed)
	$(call require_bridge)
	$(UV_RUN) acd-bridge push-ble --adapter mock --once $(NAME_ARG) $(PUSH_FLAGS)

.PHONY: push-ble-file
push-ble-file: ## One-shot BLE push from schema example (EXAMPLE=…)
	$(call require_bridge)
	@test -f "$(EXAMPLE_PATH)" || { echo "error: missing $(EXAMPLE_PATH)"; exit 1; }
	$(UV_RUN) acd-bridge push-ble \
	  --adapter "file:$(EXAMPLE_PATH)" \
	  --once \
	  $(NAME_ARG) \
	  $(PUSH_FLAGS)

# Scenario: multi-step session transitions (default builtin:lifecycle)
SCENARIO    ?= builtin:lifecycle

.PHONY: push-ble-scenario
push-ble-scenario: ## BLE push scenario transitions (SCENARIO=builtin:lifecycle|path)
	$(call require_bridge)
	$(UV_RUN) acd-bridge push-ble \
	  --adapter "scenario:$(SCENARIO)" \
	  --interval $(INTERVAL) \
	  $(ONCE_ARG) \
	  $(NAME_ARG) \
	  $(PUSH_FLAGS)

# ============================================================================
# Deck firmware (PlatformIO)
# ============================================================================

.PHONY: deck-build
deck-build: ## Compile firmware (pio run)
	cd "$(DECK_DIR)" && pio run -e "$(PIO_ENV)"

.PHONY: deck-upload
deck-upload: ## Flash firmware to the board
	cd "$(DECK_DIR)" && pio run -e "$(PIO_ENV)" -t upload

.PHONY: deck-monitor
deck-monitor: ## Serial monitor @ 115200
	cd "$(DECK_DIR)" && pio device monitor -b 115200

.PHONY: deck-flash
deck-flash: ## Upload firmware then open serial monitor
	cd "$(DECK_DIR)" && pio run -e "$(PIO_ENV)" -t upload && pio device monitor -b 115200

.PHONY: deck-clean
deck-clean: ## Remove PlatformIO build artifacts (.pio/)
	cd "$(DECK_DIR)" && pio run -e "$(PIO_ENV)" -t clean

# ============================================================================
# Host UI sim (SDL2)
# ============================================================================

.PHONY: sim-build
sim-build: ## Configure + build acd-ui-sim
	cmake -S "$(SIM_DIR)" -B "$(SIM_DIR)/build" -DCMAKE_BUILD_TYPE=$(BUILD_TYPE)
	cmake --build "$(SIM_DIR)/build"
	@echo "✓ $(SIM_BIN)"

.PHONY: sim
sim: ## Preview example snapshot in SDL window
	$(call require_sim)
	@test -f "$(EXAMPLE_PATH)" || { echo "error: missing $(EXAMPLE_PATH)"; exit 1; }
	"$(SIM_BIN)" $(SCALE_ARG) $(BMP_ARG) $(SIM_FLAGS) "$(EXAMPLE_PATH)"

.PHONY: sim-stale
sim-stale: ## Sim with STALE overlay
	$(MAKE) sim SIM_FLAGS="--stale --age-ms 45000 $(SIM_FLAGS)"

.PHONY: sim-no-link
sim-no-link: ## Sim with NO LINK frame
	$(MAKE) sim SIM_FLAGS="--no-link --age-ms 60000 $(SIM_FLAGS)"

.PHONY: sim-schema
sim-schema: ## Sim with SCHEMA fault frame
	$(MAKE) sim SIM_FLAGS="--schema $(SIM_FLAGS)"

.PHONY: sim-bmp
sim-bmp: ## Headless BMP (BMP=/tmp/deck.bmp EXAMPLE=…)
	@test -n "$(BMP)" || { echo "error: set BMP=/path/to/out.bmp"; exit 1; }
	$(MAKE) sim BMP="$(BMP)"

.PHONY: sim-live
sim-live: ## Live preview from bridge GET /v1/status (run serve separately)
	$(call require_sim)
	"$(SIM_BIN)" --from-url "$(FROM_URL)" --poll $(POLL) $(SCALE_ARG) $(SIM_FLAGS)

.PHONY: sim-clean
sim-clean: ## Remove sim CMake build dir
	rm -rf "$(SIM_DIR)/build"

# ============================================================================
# Schema
# ============================================================================

# Embedded validator (export so python -c "$$SCRIPT" works under make)
define SCHEMA_CHECK_PY
import json, os, pathlib, sys
from agent_control_deck_bridge.model import StatusSnapshot

root = pathlib.Path(os.environ["SCHEMA_EXAMPLES"])
limit, errs = 8192, 0
for p in sorted(root.glob("*.json")):
    raw = p.read_bytes()
    n = len(raw)
    size_ok = n <= limit
    try:
        StatusSnapshot.model_validate(json.loads(raw))
        model_ok, detail = True, "ok"
    except Exception as e:
        model_ok, detail = False, str(e)
        errs += 1
    if not size_ok:
        errs += 1
    flag = "ok" if model_ok and size_ok else "FAIL"
    budget = f"{n} B" if size_ok else f"{n} B > {limit}"
    extra = "" if model_ok else f"  ({detail})"
    print(f"  {flag:4}  {budget:14}  {p.name}{extra}")
sys.exit(1 if errs else 0)
endef
export SCHEMA_CHECK_PY

.PHONY: schema-check
schema-check: ## Validate schema/examples (pydantic via uv, or check-jsonschema)
	@set -e; \
	examples="$(SCHEMA_DIR)/examples"; \
	if command -v uv >/dev/null && test -d "$(VENV)"; then \
	  echo "→ StatusSnapshot (bridge pydantic) + 8 KiB budget"; \
	  SCHEMA_EXAMPLES="$$examples" $(UV_RUN) python -c "$$SCHEMA_CHECK_PY"; \
	elif command -v check-jsonschema >/dev/null 2>&1; then \
	  echo "→ check-jsonschema"; \
	  check-jsonschema --schemafile "$(SCHEMA_DIR)/status.schema.json" "$$examples"/*.json; \
	else \
	  echo "error: run make bridge-install, or install check-jsonschema"; \
	  exit 1; \
	fi
	@echo "✓ schema examples"

# ============================================================================
# BLE lab tools (tools/ble_link)
# ============================================================================

.PHONY: ble-soak
ble-soak: ## Low-level connect soak (tools/ble_link)
	$(call require_uv)
	$(UV_TOOL) python connect_soak.py $(PUSH_FLAGS)

.PHONY: ble-xfer
ble-xfer: ## Low-level chunked push of EXAMPLE schema payload
	$(call require_uv)
	@test -f "$(EXAMPLE_PATH)" || { echo "error: missing $(EXAMPLE_PATH)"; exit 1; }
	$(UV_TOOL) python push_xfer.py --payload "$(EXAMPLE_PATH)" $(PUSH_FLAGS)

# ============================================================================
# Clean
# ============================================================================

.PHONY: clean
clean: deck-clean sim-clean ## Clean deck .pio + sim build (keeps bridge .venv)

.PHONY: clean-all
clean-all: clean ## Clean + remove bridge .venv and caches
	rm -rf "$(VENV)" \
	  "$(BRIDGE_DIR)/.pytest_cache" \
	  "$(BRIDGE_DIR)/src/"*.egg-info \
	  "$(BRIDGE_DIR)/src/agent_control_deck_bridge.egg-info"
	@find "$(BRIDGE_DIR)" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	@find "$(TOOLS_DIR)" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	@echo "✓ clean-all"

# Quiet recursive make noise for thin wrappers
MAKEFLAGS += --no-print-directory
