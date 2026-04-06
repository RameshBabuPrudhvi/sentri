#!/usr/bin/env bash
# add-jsdoc-modules.sh — Add @module JSDoc headers to all remaining files
# Run from the repo root: bash scripts/add-jsdoc-modules.sh
#
# This script finds all .js files under backend/src/pipeline/ and backend/src/runner/
# that don't already have a @module tag, reads the first comment block, and replaces
# it with a proper @module header.

set -euo pipefail

add_module_header() {
  local file="$1"
  local module_path="$2"

  # Skip if already has @module
  if grep -q '@module' "$file" 2>/dev/null; then
    echo "  ✓ $file (already has @module)"
    return
  fi

  # Extract the file's existing first-line comment description
  local desc
  desc=$(head -5 "$file" | grep -oP '(?<=\* )\S.*' | head -1 || echo "")

  if [ -z "$desc" ]; then
    desc="Internal module."
  fi

  # Create the new header
  local header="/**
 * @module ${module_path}
 * @description ${desc}
 */"

  # Check if file starts with /** ... */
  if head -1 "$file" | grep -q '^\s*/\*\*'; then
    # Replace the first comment block
    local end_line
    end_line=$(grep -n '^ \*/' "$file" | head -1 | cut -d: -f1)
    if [ -n "$end_line" ]; then
      local tmp
      tmp=$(mktemp)
      echo "$header" > "$tmp"
      tail -n +"$((end_line + 1))" "$file" >> "$tmp"
      mv "$tmp" "$file"
      echo "  ✅ $file → @module ${module_path}"
      return
    fi
  fi

  # No existing comment block — prepend
  local tmp
  tmp=$(mktemp)
  echo "$header" > "$tmp"
  echo "" >> "$tmp"
  cat "$file" >> "$tmp"
  mv "$tmp" "$file"
  echo "  ✅ $file → @module ${module_path} (prepended)"
}

echo "Adding @module JSDoc headers to all files without one..."
echo ""

echo "── Backend pipeline/ ──"
for f in backend/src/pipeline/*.js; do
  name=$(basename "$f" .js)
  add_module_header "$f" "pipeline/${name}"
done

echo ""
echo "── Backend runner/ ──"
for f in backend/src/runner/*.js; do
  name=$(basename "$f" .js)
  add_module_header "$f" "runner/${name}"
done

echo ""
echo "── Backend pipeline/prompts/ ──"
for f in backend/src/pipeline/prompts/*.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .js)
  add_module_header "$f" "pipeline/prompts/${name}"
done

echo ""
echo "── Frontend pages/ ──"
for f in frontend/src/pages/*.jsx; do
  name=$(basename "$f" .jsx)
  add_module_header "$f" "pages/${name}"
done

echo ""
echo "── Frontend components/ ──"
for f in frontend/src/components/*.jsx; do
  name=$(basename "$f" .jsx)
  add_module_header "$f" "components/${name}"
done

echo ""
echo "── Frontend config/ ──"
for f in frontend/src/config/*.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .js)
  add_module_header "$f" "config/${name}"
done

echo ""
echo "── Frontend root files ──"
for f in frontend/src/App.jsx frontend/src/main.jsx frontend/src/demo.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" | sed 's/\.\(jsx\|js\)$//')
  add_module_header "$f" "${name}"
done

echo ""
echo "Done! Run 'cd backend && npm run docs' to regenerate JSDoc."
