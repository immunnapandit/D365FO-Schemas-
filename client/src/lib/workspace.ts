/** The workspace the user works in. Sent to the server with every API call (X-Workspace-Id). */

const KEY = 'sf.workspace'

let current: string | null = (() => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
})()

export const currentWorkspaceId = () => current

export function setCurrentWorkspaceId(id: string | null) {
  current = id
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode: kept for this tab only */
  }
}

/** First letter of each of the first two words: "Bata Retail" -> "BR". */
export function workspaceInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}
