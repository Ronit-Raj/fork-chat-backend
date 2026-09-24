import jwt from 'jsonwebtoken';

const envSecret = process.env.JWT_SECRET;
if (!envSecret) {
  throw new Error('JWT_SECRET environment variable is not set');
}
const JWT_SECRET: string = envSecret;

const JWT_EXPIRES_IN = '7d';

export interface JwtPayload {
  userId: string;
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as JwtPayload;
}
