import { Router } from 'express';
import { signup, login } from './auth.controller.js';
import { redirectToProvider, handleProviderCallback } from './oauth.controller.js';

export const authRouter = Router();

authRouter.post('/signup', signup);
authRouter.post('/login', login);

authRouter.get('/google', redirectToProvider('google'));
authRouter.get('/google/callback', handleProviderCallback('google'));
authRouter.get('/github', redirectToProvider('github'));
authRouter.get('/github/callback', handleProviderCallback('github'));
