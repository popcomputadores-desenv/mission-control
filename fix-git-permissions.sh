#!/usr/bin/env bash
# fix-git-permissions.sh
# Fixes false git changes caused by file permission drift when copying repos between machines.
# Usage:
#   ./fix-git-permissions.sh              # fix current directory (must be a git repo)
#   ./fix-git-permissions.sh /path/to/repo
#   ./fix-git-permissions.sh /parent/dir --all   # recurse all git repos under a parent dir

set -euo pipefail

# ── helpers ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

fix_repo() {
    local repo_dir="$1"

    if ! git -C "$repo_dir" rev-parse --git-dir &>/dev/null; then
        error "'$repo_dir' is not a git repository. Skipping."
        return 1
    fi

    info "Processing repo: $repo_dir"

    # ── 1. Disable fileMode tracking ─────────────────────────────────────────
    git -C "$repo_dir" config core.fileMode false
    info "  core.fileMode set to false"

    # ── 2. Count changes BEFORE cleanup ──────────────────────────────────────
    local before
    before=$(git -C "$repo_dir" status --short | grep -v "^??" | wc -l | tr -d ' ')
    info "  Tracked changes before cleanup: $before"

    # ── 3. Reset permission bits to git-expected values (644 for files, 755 for dirs/executables)
    #       This restores what git thinks the permissions should be, without touching content.
    git -C "$repo_dir" diff --name-only --diff-filter=M HEAD 2>/dev/null | while read -r f; do
        local full="$repo_dir/$f"
        if [[ -f "$full" ]]; then
            # Get the mode git has stored for this file
            local git_mode
            git_mode=$(git -C "$repo_dir" ls-files -s -- "$f" | awk '{print $1}')
            if [[ "$git_mode" == "100755" ]]; then
                chmod 755 "$full"
            else
                chmod 644 "$full"
            fi
        fi
    done
    info "  File permissions restored to git-tracked values"

    # ── 4. Count REAL content changes after cleanup ───────────────────────────
    local after
    after=$(git -C "$repo_dir" status --short | grep -v "^??" | wc -l | tr -d ' ')
    info "  Real content changes remaining: $after"

    # ── 5. Show the real changes so the user can review them ──────────────────
    if [[ "$after" -gt 0 ]]; then
        warn "  The following files have REAL content changes (not permission noise):"
        git -C "$repo_dir" status --short | grep -v "^??" | sed 's/^/    /'
    else
        info "  No real content changes — working tree is clean."
    fi

    echo ""
}

# ── main ─────────────────────────────────────────────────────────────────────
TARGET="${1:-.}"
MODE="${2:-}"

if [[ "$MODE" == "--all" ]]; then
    info "Scanning for git repos under: $TARGET"
    while IFS= read -r gitdir; do
        repo=$(dirname "$gitdir")
        fix_repo "$repo"
    done < <(find "$TARGET" -maxdepth 3 -name ".git" -type d 2>/dev/null)
else
    fix_repo "$TARGET"
fi

info "Done."
