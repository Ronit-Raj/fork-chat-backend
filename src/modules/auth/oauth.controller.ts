import type { Request, Response } from 'express';
import { prisma } from '../../db.js';
import { signToken } from '../../lib/jwt.js';
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForProfile,
  verifyOAuthState,
  type OAuthProviderName,
} from '../../lib/oauth.js';

function getFrontendUrl(): string {
  return process.env.FRONTEND_URL ?? 'http://localhost:3005';
}

export function redirectToProvider(provider: OAuthProviderName) {
  return (_req: Request, res: Response) => {
    const state = createOAuthState();
    res.redirect(buildAuthorizeUrl(provider, state));
  };
}

export function handleProviderCallback(provider: OAuthProviderName) {
  return async (req: Request, res: Response) => {
    const { code, state } = req.query;
    const frontendUrl = getFrontendUrl();

    if (typeof code !== 'string' || typeof state !== 'string' || !verifyOAuthState(state)) {
      res.redirect(`${frontendUrl}/callback?error=invalid_oauth_request`);
      return;
    }

    try {
      const profile = await exchangeCodeForProfile(provider, code);

      // Find-or-create, linking by (provider, providerAccountId) first and
      // falling back to an existing account with the same verified email —
      // see CLAUDE.md / conversation notes for the tradeoffs of that choice.
      const existingAccount = await prisma.oAuthAccount.findUnique({
        where: {
          provider_providerAccountId: {
            provider,
            providerAccountId: profile.providerAccountId,
          },
        },
        include: { user: true },
      });

      const user =
        existingAccount?.user ??
        (await prisma.user.upsert({
          where: { email: profile.email },
          update: {},
          create: { email: profile.email, name: profile.name },
        }));

      if (!existingAccount) {
        await prisma.oAuthAccount.create({
          data: {
            provider,
            providerAccountId: profile.providerAccountId,
            userId: user.id,
          },
        });
      }

      // Backfill the display name for accounts created before names were
      // kept. Never overwrites a name the user already has.
      let displayName = user.name;
      if (!displayName && profile.name) {
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { name: profile.name },
        });
        displayName = updated.name;
      }

      const token = signToken({ userId: user.id, email: user.email, name: displayName });
      res.redirect(`${frontendUrl}/callback?token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error(`${provider} OAuth callback failed:`, err);
      res.redirect(`${frontendUrl}/callback?error=oauth_failed`);
    }
  };
}
