import 'dotenv/config';
import { app } from './app.js';

// Vercel imports this module and invokes the default-exported app per request;
// it must not bind a port there. Locally (dev/start) we listen as usual.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`fork-chat-backend listening on port ${PORT}`);
  });
}

export default app;
