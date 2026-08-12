.DEFAULT_GOAL := help
.PHONY: help setup dev check format lint typecheck test test-e2e build preview

help:
	@echo "make setup      install deps (and the playwright browser)"
	@echo "make dev        start dev server (http://localhost:5173)"
	@echo "make check      full quality gate: lint + typecheck + test + build"
	@echo "make format     auto-fix formatting + lint (biome)"
	@echo "make lint       lint quality, no fix (biome)"
	@echo "make typecheck  type checks (tsc)"
	@echo "make test       unit and regression tests (vitest)"
	@echo "make test-e2e   end-to-end tests against a real browser (playwright)"
	@echo "make build      production build into dist/"
	@echo "make preview    serve the production build locally"

check: lint typecheck test build

setup:
	pnpm install
	pnpm exec playwright install chromium

dev:
	pnpm dev

format:
	pnpm exec biome check --write

lint:
	pnpm exec biome check

typecheck:
	pnpm exec tsc -b

test:
	pnpm exec vitest run

test-e2e:
	pnpm exec playwright test

build:
	pnpm build

preview:
	pnpm preview
