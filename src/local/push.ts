// What a pre-push hook has to check. git writes one line per ref on the hook's stdin:
// `<local ref> <local sha> <remote ref> <remote sha>`. The commit to check is the local sha, never the
// checkout's HEAD: `git push origin HEAD:refs/heads/x`, a sha or another branch all send something
// else. The destination decides what is a branch, since the source may be `HEAD` or a bare sha.
export interface PushedBranch {
  readonly sha: string
  // The remote branch's name, without `refs/heads/`.
  readonly branch: string
}

const ZERO = /^0+$/

export const branchesToCheck = (stdin: string): ReadonlyArray<PushedBranch> =>
  stdin.split("\n").flatMap((line) => {
    const [, localSha = "", remoteRef = ""] = line.trim().split(/\s+/)
    // Tags and other refs are not PRs; an all-zero local sha deletes the remote branch.
    if (!remoteRef.startsWith("refs/heads/") || localSha === "" || ZERO.test(localSha)) return []
    return [{ sha: localSha, branch: remoteRef.slice("refs/heads/".length) }]
  })
