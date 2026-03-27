#!/bin/bash
# Run this from inside your cloned sentri repo directory
# Usage: bash setup-workflows.sh

set -e

echo "📁 Creating .github/workflows/ directory..."
mkdir -p .github/workflows

echo "📝 Writing ci.yml..."
cat > .github/workflows/ci.yml << 'WORKFLOW_CI'
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  backend:
    name: Backend — Install & Syntax Check
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: node --check src/index.js src/crawler.js src/testRunner.js src/db.js
      - name: Smoke test
        run: |
          node src/index.js &
          for i in $(seq 1 10); do
            curl -sf http://localhost:3001/api/dashboard > /dev/null 2>&1 && echo "✅ Server up" && break
            sleep 2
          done
          curl -sf http://localhost:3001/api/projects | grep -q "\[\]" && echo "✅ API OK"
          kill $(lsof -ti:3001) 2>/dev/null || true
        env:
          ANTHROPIC_API_KEY: sk-ant-ci-placeholder
          PORT: 3001

  frontend:
    name: Frontend — Install & Build
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - run: npm run build

  docker:
    name: Docker — Build Both Images
    runs-on: ubuntu-latest
    needs: [backend, frontend]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v5
        with:
          context: ./backend
          push: false
          tags: sentri-backend:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: docker/build-push-action@v5
        with:
          context: ./frontend
          push: false
          tags: sentri-frontend:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
WORKFLOW_CI

echo "📝 Writing cd.yml..."
cat > .github/workflows/cd.yml << 'WORKFLOW_CD'
name: CD — Build & Push Images

on:
  push:
    branches: [main]

env:
  REGISTRY: ghcr.io
  BACKEND_IMAGE: ghcr.io/${{ github.repository_owner }}/sentri-backend
  FRONTEND_IMAGE: ghcr.io/${{ github.repository_owner }}/sentri-frontend

jobs:
  build-and-push:
    name: Build & Push to GHCR
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta-backend
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.BACKEND_IMAGE }}
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest
      - id: meta-frontend
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.FRONTEND_IMAGE }}
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest
      - uses: docker/build-push-action@v5
        with:
          context: ./backend
          push: true
          tags: ${{ steps.meta-backend.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: docker/build-push-action@v5
        with:
          context: ./frontend
          push: true
          tags: ${{ steps.meta-frontend.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
WORKFLOW_CD

echo ""
echo "✅ Workflow files created!"
echo ""
echo "Now run:"
echo "  git add .github/"
echo "  git commit -m 'ci: add GitHub Actions workflows'"
echo "  git push"
echo ""
echo "Then check: https://github.com/RameshBabuPrudhvi/sentri/actions"
