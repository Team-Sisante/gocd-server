#!/bin/bash
# Security Hook: Prevent committing raw secret files

# Forbidden patterns
FORBIDDEN_FILES=(".env" ".env.common" ".env.dev" ".env.staging" ".env.production" ".env.docker" ".env.test.*")
FORBIDDEN_EXTENSIONS=(".key" ".pem" ".p12")

staged_files=$(git diff --cached --name-only)

for file in $staged_files; do
    # Check for exact matches of raw .env files
    for forbidden in "${FORBIDDEN_FILES[@]}"; do
        if [[ "$file" == "$forbidden" ]]; then
            echo -e "\x1b[31m[SECURITY BLOCK] Committing raw secret file '$file' is forbidden.\x1b[0m"
            exit 1
        fi
    done

    # Check for forbidden extensions
    for ext in "${FORBIDDEN_EXTENSIONS[@]}"; do
        if [[ "$file" == *"$ext" ]]; then
            echo -e "\x1b[31m[SECURITY BLOCK] Committing sensitive file type '$file' is forbidden.\x1b[0m"
            exit 1
        fi
    done
done

exit 0
