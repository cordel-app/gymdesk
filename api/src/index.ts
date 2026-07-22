import { app } from './app';
import { logger } from './lib/logger';

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY environment variable is required');
}

const port = process.env.PORT ?? 3000;
app.listen(port, () => {
  logger.info({ port }, 'Backend running');
});
