import type { Request, Response } from 'express';
import { prisma } from '../../db.js';
import { hashPassword, comparePassword } from '../../lib/password.js';
import { signToken } from '../../lib/jwt.js';

export async function signup(req: Request, res: Response) {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'email and password (min 8 chars) are required' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const token = signToken({ userId: user.id, email: user.email });
  res.status(201).json({ token });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !(await comparePassword(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signToken({ userId: user.id, email: user.email });
  res.json({ token });
}
