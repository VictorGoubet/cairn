.DEFAULT_GOAL := help
.PHONY: help setup dev format lint typecheck build preview

help:
	@echo "make setup      install deps"
	@echo "make dev        start dev server (http://localhost:5173)"
	@echo "make format     auto-fix formatting + lint (biome)"
	@echo "make lint       lint quality, no fix (biome)"
	@echo "make typecheck  type checks (tsc)"
	@echo "make build      production build into dist/"
	@echo "make preview    serve the production build locally"

setup:
	npm install

dev:
	npm run dev

format:
	npx biome check --write

lint:
	npx biome check

typecheck:
	npx tsc -b

build:
	npm run build

preview:
	npm run preview
