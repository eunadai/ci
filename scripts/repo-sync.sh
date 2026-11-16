#!/usr/bin/env bash
# Keeps local clones in step with their remotes without ever touching work in progress.
# Every local branch that is strictly behind its upstream is fast-forwarded; anything else
# (local commits, a branch open in another worktree, uncommitted changes the update would
# overwrite, a rebase or merge in progress) is left as it is and written to the log.
#
# Usage:
#   scripts/repo-sync.sh [--dry-run]       sync every repo in the config, once
#   scripts/repo-sync.sh install [seconds] run it every <seconds> (default 60) with launchd (macOS)
#   scripts/repo-sync.sh uninstall         remove the launchd agent
#
# Config: $REPO_SYNC_CONFIG (default ~/.config/repo-sync/repos): one path or glob per line, '#' starts
#         a comment, '~' is expanded. Only clone roots count (a folder with a .git directory): other
#         folders and linked worktrees are ignored, so a glob over a code folder picks up new clones.
# Log:    $REPO_SYNC_LOG (default ~/Library/Logs/repo-sync.log on macOS, ~/.local/state/repo-sync.log
#         elsewhere). Only changes are logged: a skip or failure is written once, until it changes.
# Notify: REPO_SYNC_NOTIFY=1 also shows each new skip or failure as a macOS notification.
# Cost:   each run first asks every remote where its refs point (git ls-remote, no download) and
#         fetches only the repos whose remote changed, so a merge lands within one interval. Every
#         $REPO_SYNC_FULL_EVERY seconds (default 600) a full pass fetches all of them again, which
#         also retries branches a skip left behind (say, once the uncommitted change is gone).
#         Repos run $REPO_SYNC_JOBS at a time (default 8).
#
# Everything runs inside main, called on the last line: bash reads a script while it runs, and this
# script may fast-forward its own clone.

set -uo pipefail

config=${REPO_SYNC_CONFIG:-$HOME/.config/repo-sync/repos}
if [ "$(uname)" = Darwin ]; then default_log=$HOME/Library/Logs/repo-sync.log; else default_log=$HOME/.local/state/repo-sync.log; fi
log_file=${REPO_SYNC_LOG:-$default_log}
state_dir=${REPO_SYNC_STATE:-$HOME/.local/state/repo-sync}
label=${REPO_SYNC_LABEL:-local.repo-sync}
full_every=${REPO_SYNC_FULL_EVERY:-600}
jobs=${REPO_SYNC_JOBS:-8}
dry_run=0
full_pass=0
lock=

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}

now() { date +%Y-%m-%dT%H:%M:%S; }
state_file() { printf '%s/%s' "$state_dir" "$(printf '%s\t%s' "$1" "$2" | cksum | tr -s ' ' '-')"; }

# record <repo> <branch> <OK|SKIP|FAIL> <detail>: OK is always logged; SKIP and FAIL only when the
# detail differs from the last one recorded for that repo and branch.
record() {
  local repo=$1 branch=$2 status=$3 detail=$4 file
  file=$(state_file "$repo" "$branch")
  if [ "$status" = OK ]; then
    rm -f "$file"
  else
    [ -f "$file" ] && [ "$(cat "$file")" = "$status $detail" ] && return 0
    printf '%s %s\n' "$status" "$detail" >"$file"
    if [ "${REPO_SYNC_NOTIFY:-0}" = 1 ] && command -v osascript >/dev/null; then
      osascript -e "display notification \"${detail//\"/\'}\" with title \"repo-sync: ${repo##*/} ${branch}\"" >/dev/null 2>&1
    fi
  fi
  printf '%s %-4s %s %s: %s\n' "$(now)" "$status" "$repo" "$branch" "$detail" >>"$log_file"
}

# A rebase, merge, cherry-pick, revert or bisect in any worktree: the refs are mid-change.
operation_in_progress() {
  local common d
  common=$(git -C "$1" rev-parse --git-common-dir) || return 0
  case $common in /*) ;; *) common=$1/$common ;; esac
  for d in "$common" "$common"/worktrees/*; do
    [ -d "$d" ] || continue
    if [ -e "$d/rebase-merge" ] || [ -e "$d/rebase-apply" ] || [ -e "$d/MERGE_HEAD" ] ||
      [ -e "$d/CHERRY_PICK_HEAD" ] || [ -e "$d/REVERT_HEAD" ] || [ -e "$d/BISECT_LOG" ]; then
      return 0
    fi
  done
  return 1
}

sync_repo() {
  local repo=$1 out sig sig_file worktrees main_wt ref up counts ahead behind name wt
  # Only a clone's own root: not a folder inside one, and not a linked worktree (its .git is a file),
  # whose branches the main clone already covers.
  [ -d "$repo/.git" ] || return 0

  # Cheap check: where every remote's refs point. Unchanged since the last fetch, and not a full
  # pass, means there is nothing new to bring in.
  sig_file=$(state_file "$repo" "#remote")
  if out=$(for r in $(git -C "$repo" remote); do git -C "$repo" ls-remote --heads --tags "$r" || exit 1; done 2>&1); then
    sig=$(printf '%s' "$out" | cksum)
    [ $full_pass = 0 ] && [ -f "$sig_file" ] && [ "$(cat "$sig_file")" = "$sig" ] && return 0
  else
    sig=
    if [ $full_pass = 0 ]; then
      record "$repo" "-" FAIL "fetch: $(printf '%s' "$out" | grep -m1 -E 'fatal|error' || printf '%s' "$out" | head -1)"
      return 0
    fi
  fi

  if ! out=$(git -C "$repo" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --all --prune --quiet 2>&1); then
    record "$repo" "-" FAIL "fetch: $(printf '%s' "$out" | grep -m1 -E 'fatal|error' || printf '%s' "$out" | head -1)"
    return 0
  fi
  rm -f "$(state_file "$repo" "-")" "$(state_file "$repo" "*")"
  if [ -n "$sig" ]; then printf '%s' "$sig" >"$sig_file"; else rm -f "$sig_file"; fi
  if operation_in_progress "$repo"; then
    record "$repo" "*" SKIP "rebase, merge, cherry-pick or bisect in progress"
    return 0
  fi

  # "<ref>\t<worktree path>" for every branch checked out somewhere; the first worktree is the main one.
  worktrees=$(git -C "$repo" worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^branch /{print substr($0,8) "\t" p}')
  main_wt=$(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')

  while IFS=$'\t' read -r ref up; do
    [ -n "$up" ] || continue
    git -C "$repo" rev-parse -q --verify "$up^{commit}" >/dev/null || continue
    counts=$(git -C "$repo" rev-list --left-right --count "$ref...$up") || continue
    ahead=${counts%%[[:space:]]*}
    behind=${counts##*[[:space:]]}
    name=${ref#refs/heads/}
    [ "$behind" -eq 0 ] && continue
    if [ "$ahead" -gt 0 ]; then
      record "$repo" "$name" SKIP "$ahead local commit(s) not on ${up#refs/remotes/}, $behind behind"
      continue
    fi
    wt=$(printf '%s\n' "$worktrees" | awk -F'\t' -v r="$ref" '$1 == r {print $2; exit}')
    if [ -n "$wt" ] && [ "$wt" != "$main_wt" ]; then
      record "$repo" "$name" SKIP "checked out in another worktree ($wt), $behind behind"
    elif [ $dry_run = 1 ]; then
      record "$repo" "$name" OK "would fast-forward $behind commit(s)${wt:+ (checked out; skipped if uncommitted changes are in the way)}"
    elif [ -z "$wt" ]; then
      # fetch into a local branch refuses anything but a fast-forward, and branches checked out anywhere.
      if out=$(git -C "$repo" fetch --quiet . "$up:$ref" 2>&1); then
        record "$repo" "$name" OK "fast-forward $behind commit(s)"
      else
        record "$repo" "$name" SKIP "$(printf '%s' "$out" | head -1)"
      fi
    else
      # merge --ff-only stops before touching anything when uncommitted changes would be overwritten.
      if out=$(git -C "$wt" merge --ff-only --quiet "$up" 2>&1); then
        record "$repo" "$name" OK "fast-forward $behind commit(s) (checked out)"
      else
        record "$repo" "$name" SKIP "uncommitted changes in the way: $(printf '%s' "$out" | grep -m1 -vE '^(error|hint|Please|Aborting)' | sed 's/^[[:space:]]*//')"
      fi
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname)%09%(upstream)' refs/heads)
}

run_all() {
  local line pattern path last IFS=$'\n'
  lock=${TMPDIR:-/tmp}/repo-sync.$(id -u).lock
  mkdir -p "$state_dir" "$(dirname "$log_file")"
  if ! mkdir "$lock" 2>/dev/null; then
    if kill -0 "$(cat "$lock/pid" 2>/dev/null)" 2>/dev/null; then return 0; fi
    rm -rf "$lock" && mkdir "$lock" || return 1
  fi
  echo $$ >"$lock/pid"
  trap 'rm -rf "$lock"' EXIT
  if [ -f "$log_file" ] && [ "$(wc -c <"$log_file")" -gt 1048576 ]; then mv -f "$log_file" "$log_file.1"; fi
  if [ ! -f "$config" ]; then
    echo "repo-sync: no config at $config (one path or glob per line)" >&2
    return 1
  fi
  last=$(cat "$state_dir/last-full" 2>/dev/null || echo 0)
  if [ $dry_run = 1 ] || [ $(($(date +%s) - last)) -ge "$full_every" ]; then full_pass=1; fi

  while IFS= read -r line || [ -n "$line" ]; do
    pattern=${line%%#*}
    pattern=$(printf '%s' "$pattern" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$pattern" ] || continue
    case $pattern in "~"*) pattern=$HOME${pattern#\~} ;; esac
    for path in $pattern; do
      [ -d "$path/.git" ] || continue
      # Repos share nothing, so they sync side by side, $jobs at a time.
      while [ "$(jobs -rp | wc -l)" -ge "$jobs" ]; do sleep 0.2; done
      sync_repo "${path%/}" &
    done
  done <"$config"
  wait
  if [ $full_pass = 1 ] && [ $dry_run = 0 ]; then date +%s >"$state_dir/last-full"; fi
}

xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

install_agent() {
  local interval=${1:-60} script plist
  [ "$(uname)" = Darwin ] || { echo "install uses launchd, macOS only; elsewhere, run the script from cron" >&2; return 1; }
  script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  plist=$HOME/Library/LaunchAgents/$label.plist
  mkdir -p "$(dirname "$config")" "$(dirname "$log_file")" "$HOME/Library/LaunchAgents"
  if [ ! -f "$config" ]; then
    printf '# One path or glob per line. Paths that are not git repositories are ignored.\n# ~/code/*\n' >"$config"
    echo "created $config: list the repos there"
  fi
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(xml "$script")</string></array>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>REPO_SYNC_NOTIFY</key><string>$(xml "${REPO_SYNC_NOTIFY:-0}")</string>
    <key>REPO_SYNC_CONFIG</key><string>$(xml "$config")</string>
    <key>REPO_SYNC_LOG</key><string>$(xml "$log_file")</string>
    <key>REPO_SYNC_STATE</key><string>$(xml "$state_dir")</string>
  </dict>
  <key>StandardErrorPath</key><string>$(xml "$log_file")</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$plist" && echo "installed $label: every ${interval}s, log at $log_file"
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "removed $label"
}

main() {
  case ${1:-} in
    install) install_agent "${2:-}" ;;
    uninstall) uninstall_agent ;;
    # A dry run keeps its state in a throwaway folder, so the next real run still sees every change.
    --dry-run) dry_run=1; state_dir=$(mktemp -d); run_all; rm -rf "$state_dir" ;;
    "") run_all ;;
    *) sed -n '2,20p' "$0" >&2; return 2 ;;
  esac
}

main "$@"; exit
