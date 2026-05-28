import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface UserClaims {
  sub: string;
  email: string;
  groups: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: UserClaims;
    }
  }
}

const region = process.env.AWS_REGION || 'ap-south-1';
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_APP_CLIENT_ID;

// JWKS fetcher — caches public keys internally, re-fetches on rotation
const JWKS = userPoolId
  ? createRemoteJWKSet(
      new URL(
        `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
      ),
    )
  : null;

export async function extractUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // If Cognito is not configured and we're in dev → use a mock user for quick local runs
  if (!JWKS || !userPoolId || !clientId) {
    if (process.env.NODE_ENV === 'development') {
      req.user = {
        sub: 'dev-user',
        email: process.env.DEV_USER_EMAIL || 'dev@localhost',
        groups: ['data-loader-dev'],
      };
      next();
      return;
    }
    res.status(500).json({ error: 'Auth not configured on server' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
      audience: clientId,
    });

    req.user = {
      sub: payload.sub as string,
      email: payload.email as string,
      groups: (payload['cognito:groups'] as string[] | undefined) ?? [],
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireGroup(group: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user?.groups.includes(group)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
