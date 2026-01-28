import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/core',
  'packages/messaging',
  'packages/channels',
  'packages/memory',
  'packages/agent',
  'packages/bot',
]);
