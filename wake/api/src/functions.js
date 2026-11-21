import { app } from '@azure/functions';
import { statusHandler, wakeHandler } from './handlers.js';

app.http('status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'status',
  handler: () => statusHandler(process.env),
});

app.http('wake', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'wake',
  handler: () => wakeHandler(process.env),
});
