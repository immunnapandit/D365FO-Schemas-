import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser'

/**
 * Sign-in. The server tells us which mode is used (GET /api/config), so the same build
 * works in every environment:
 *  - entra:    MSAL redirect login, access token for the API on every call
 *  - easyauth: Azure App Service / Container Apps handles login; cookies are sent automatically
 *  - none:     local development
 */

export interface AppConfig {
  authMode: 'entra' | 'easyauth' | 'none'
  tenantId?: string
  spaClientId?: string
  apiScope?: string
  version?: string
}

let cfg: AppConfig = { authMode: 'none' }
let msal: PublicClientApplication | null = null
let account: AccountInfo | null = null

export async function initAuth(): Promise<AppConfig> {
  const res = await fetch('/api/config', { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Could not load app configuration (HTTP ${res.status})`)
  cfg = (await res.json()) as AppConfig

  if (cfg.authMode === 'entra') {
    msal = new PublicClientApplication({
      auth: {
        clientId: cfg.spaClientId!,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
        redirectUri: window.location.origin,
        postLogoutRedirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'sessionStorage' },
    })
    await msal.initialize()
    const result = await msal.handleRedirectPromise()
    account = result?.account ?? msal.getActiveAccount() ?? msal.getAllAccounts()[0] ?? null
    if (!account) {
      // remember where the user was going, then sign in
      sessionStorage.setItem('sf.returnTo', window.location.hash)
      await msal.loginRedirect({ scopes: [cfg.apiScope!] })
      return new Promise(() => {}) // page is navigating away
    }
    msal.setActiveAccount(account)
    const returnTo = sessionStorage.getItem('sf.returnTo')
    if (returnTo) {
      sessionStorage.removeItem('sf.returnTo')
      history.replaceState(null, '', returnTo || window.location.pathname)
    }
  }
  return cfg
}

/** Authorization header for API calls ({} when the platform handles auth). */
export async function authHeaders(): Promise<Record<string, string>> {
  if (cfg.authMode !== 'entra' || !msal || !account) return {}
  try {
    const r = await msal.acquireTokenSilent({ scopes: [cfg.apiScope!], account })
    return { Authorization: `Bearer ${r.accessToken}` }
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      await msal.acquireTokenRedirect({ scopes: [cfg.apiScope!], account })
      return new Promise(() => {})
    }
    throw e
  }
}

/** Called when the API says 401: the session is gone, sign in again. */
export async function reauthenticate() {
  if (cfg.authMode === 'entra' && msal) {
    await msal.loginRedirect({ scopes: [cfg.apiScope!] })
  } else if (cfg.authMode === 'easyauth') {
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname + window.location.hash)}`
  }
}

export async function signOut() {
  if (cfg.authMode === 'entra' && msal) {
    await msal.logoutRedirect({ account })
  } else if (cfg.authMode === 'easyauth') {
    window.location.href = '/.auth/logout?post_logout_redirect_uri=/'
  }
}

export const canSignOut = () => cfg.authMode !== 'none'
