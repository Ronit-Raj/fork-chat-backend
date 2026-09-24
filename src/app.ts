import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { authRouter } from './modules/auth/auth.routes.js';
import { chatsRouter } from './modules/chats/chats.routes.js';
import { authenticate } from './middleware/auth.js';

export const app = express();
app.use(cors({ origin: 'http://localhost:3005' }));
app.use(express.json());

app.use('/auth', authRouter);
app.use(authenticate, chatsRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
};
app.use(errorHandler);
