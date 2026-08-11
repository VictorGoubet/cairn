.DEFAULT_GOAL := help
.PHONY: help setup dev check format lint typecheck build preview

help:
	@echo "make setup      install deps"
	@echo "make dev        start dev server (http://localhost:5173)"
	@echo "make check      full quality gate: lint + typecheck + build"
	@echo "make format     auto-fix formatting + lint (biome)"
	@echo "make lint       lint quality, no fix (biome)"
	@echo "make typecheck  type checks (tsc)"
	@echo "make build      production build into dist/"
	@echo "make preview    serve the production build locally"

check: lint typecheck build

setup:
	pnpm install

dev:
	pnpm dev

format:
	pnpm exec biome check --write

lint:
	pnpm exec biome check

typecheck:
	pnpm exec tsc -b

build:
	pnpm build

preview:
	pnpm preview
