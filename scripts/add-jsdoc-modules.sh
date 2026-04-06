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

echo "Adding @module JSDoc headers to pipeline/ and runner/ files..."
echo ""

# Pipeline modules
for f in backend/src/pipeline/*.js; do
  name=$(basename "$f" .js)
  add_module_header "$f" "pipeline/${name}"
done

# Runner modules
for f in backend/src/runner/*.js; do
  name=$(basename "$f" .js)
  add_module_header "$f" "runner/${name}"
done

# Pipeline prompt templates
for f in backend/src/pipeline/prompts/*.js; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .js)
  add_module_header "$f" "pipeline/prompts/${name}"
done

echo ""
echo "Done! Run 'cd backend && npm run docs' to regenerate JSDoc."
