import jwt from 'jsonwebtoken';

const envSecret = process.env.JWT_SECRET;
if (!envSecret) {
  throw new Error('JWT_SECRET environment variable is not set');
}
const STATE_SECRET: string = envSecret;

const STATE_EXPIRES_IN = '10m';

/**
 * The OAuth `state` param is a short-lived, self-verifying JWT rather than a
 * server-stored value, so the login flow needs no session/cookie store and
 * stays consistent with the rest of the app's stateless-JWT auth model.
 */
export function createOAuthState(): string {
  return jwt.sign({ purpose: 'oauth-state' }, STATE_SECRET, { expiresIn: STATE_EXPIRES_IN });
}

export function verifyOAuthState(state: string): boolean {
  try {
    const payload = jwt.verify(state, STATE_SECRET) as { purpose?: string };
    return payload.purpose === 'oauth-state';
  } catch {
    return false;
  }
}

export type OAuthProviderName = 'google' | 'github';

export interface OAuthProfile {
  providerAccountId: string;
  email: string;
}

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

function getBackendUrl(): string {
  return process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

function getProviderConfig(provider: OAuthProviderName): OAuthProviderConfig {
  const envPrefix = provider === 'google' ? 'GOOGLE' : 'GITHUB';
  const clientId = process.env[`${envPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(
      `${envPrefix}_CLIENT_ID / ${envPrefix}_CLIENT_SECRET environment variables are not set`
    );
  }

  return {
    clientId,
    clientSecret,
    callbackUrl: `${getBackendUrl()}/auth/${provider}/callback`,
  };
}

export function buildAuthorizeUrl(provider: OAuthProviderName, state: string): string {
  const { clientId, callbackUrl } = getProviderConfig(provider);

  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeGoogleCode(code: string, config: OAuthProviderConfig): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Google token exchange response missing access_token');
  }
  return body.access_token;
}

async function fetchGoogleProfile(accessToken: string): Promise<OAuthProfile> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Google profile fetch failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean };
  if (!body.sub || !body.email) {
    throw new Error('Google profile response missing sub/email');
  }
  if (!body.email_verified) {
    throw new Error('Google account email is not verified');
  }

  return { providerAccountId: body.sub, email: body.email };
}

async function exchangeGithubCode(code: string, config: OAuthProviderConfig): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) {
    throw new Error(`GitHub token exchange response missing access_token (${body.error ?? 'unknown error'})`);
  }
  return body.access_token;
}

async function fetchGithubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fork-chat-backend',
  };

  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed: ${userRes.status} ${await userRes.text()}`);
  }
  const user = (await userRes.json()) as { id?: number; email?: string | null };
  if (!user.id) {
    throw new Error('GitHub user response missing id');
  }

  // GitHub only returns `email` on /user when the user has made it public;
  // otherwise it's null and the verified primary address has to be looked up
  // separately.
  if (user.email) {
    return { providerAccountId: String(user.id), email: user.email };
  }

  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  if (!emailsRes.ok) {
    throw new Error(`GitHub emails fetch failed: ${emailsRes.status} ${await emailsRes.text()}`);
  }
  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) {
    throw new Error('GitHub account has no verified primary email');
  }

  return { providerAccountId: String(user.id), email: primary.email };
}

export async function exchangeCodeForProfile(
  provider: OAuthProviderName,
  code: string
): Promise<OAuthProfile> {
  const config = getProviderConfig(provider);

  if (provider === 'google') {
    const accessToken = await exchangeGoogleCode(code, config);
    return fetchGoogleProfile(accessToken);
  }

  const accessToken = await exchangeGithubCode(code, config);
  return fetchGithubProfile(accessToken);
}
