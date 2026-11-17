import type { AuthType } from './types'

export const AUTH_OPTIONS: { value: AuthType; label: string; hint: string }[] = [
  { value: 'oauth2_client_credentials', label: 'Microsoft Entra ID app (client ID and secret)', hint: 'Used by D365 Finance & Operations and other Entra ID protected APIs.' },
  { value: 'oauth2_password', label: 'Token URL with user name and password', hint: 'OAuth 2.0 sign-in with a service account.' },
  { value: 'token_endpoint', label: 'Custom login request', hint: 'Call any login URL and read the token from its response.' },
  { value: 'bearer_static', label: 'Fixed bearer token', hint: 'A token you already have.' },
  { value: 'basic', label: 'Basic (user name and password)', hint: 'Sent with every request.' },
  { value: 'api_key', label: 'API key header', hint: 'A fixed header such as Ocp-Apim-Subscription-Key.' },
  { value: 'none', label: 'No authentication', hint: 'The API is open.' },
]
