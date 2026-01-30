#!/usr/bin/env node
/**
 * Bot CLI Entry Point
 *
 * Bootstraps the bot, handles process signals, and manages graceful shutdown.
 *
 * @see @bot-cli
 */

import process from 'node:process';
import { createLogger } from '@kynetic-bot/core';
import type { NormalizedMessage } from '@kynetic-bot/core';
import {
  DiscordAdapter,
  DiscordAdapterConfigSchema,
  ChannelLifecycle,
} from '@kynetic-bot/channels';
import { Bot, loadConfig } from './index.js';

const log = createLogger('cli');
const FORCE_EXIT_TIMEOUT = 30000;

let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let bot: Bot | null = null;
let channelLifecycle: ChannelLifecycle | null = null;

/**
 * Main entry point
 *
 * AC-1: pnpm start or node dist/cli.js → loads config, creates bot, starts listening
 */
async function main(): Promise<void> {
  log.info('Loading configuration...');
  const config = loadConfig();

  log.info('Creating bot...');
  bot = await Bot.create(config);

  // Parse Discord config with zod schema (applies defaults for intents, partials, etc.)
  const discordConfig = DiscordAdapterConfigSchema.parse({ token: config.discordToken });
  const discordAdapter = new DiscordAdapter(discordConfig);
  channelLifecycle = new ChannelLifecycle(discordAdapter, {
    healthCheckInterval: config.healthCheckInterval,
  });

  bot.setChannelLifecycle(channelLifecycle);
  discordAdapter.onMessage((msg: NormalizedMessage) => void bot!.handleMessage(msg));

  log.info('Connecting to Discord...');
  await channelLifecycle.start();

  log.info('Starting bot...');
  await bot.start();

  log.info('Bot is running. Press Ctrl+C to stop.');
}

/**
 * Graceful shutdown handler
 *
 * @trait-graceful-shutdown - Drains messages, stops components in order
 */
async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) {
    // Already shutting down, wait for existing shutdown
    if (shutdownPromise) await shutdownPromise;
    return;
  }
  isShuttingDown = true;

  log.info(`Shutdown initiated: ${reason}`);

  const forceExitTimer = setTimeout(() => {
    log.error('Forced exit - shutdown timeout exceeded');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT);
  forceExitTimer.unref();

  shutdownPromise = (async () => {
    try {
      // Bot.stop() handles channelLifecycle internally, but if bot
      // failed to create, we still need to clean up channelLifecycle
      if (bot) {
        await bot.stop();
      } else if (channelLifecycle) {
        await channelLifecycle.stop();
      }
      clearTimeout(forceExitTimer);
      log.info('Shutdown complete');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Shutdown error', { error: error.message });
      throw err;
    }
  })();

  try {
    await shutdownPromise;
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

// AC-2: SIGINT (Ctrl+C) → initiates graceful shutdown
process.on('SIGINT', () => void shutdown('SIGINT'));

// AC-3: SIGTERM → initiates graceful shutdown
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// AC-4: uncaught exception → logs error, attempts graceful shutdown, exits with code 1
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});

// AC-5: unhandled promise rejection → logs error, attempts graceful shutdown, exits with code 1
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log.error('Unhandled rejection', { error: error.message });
  void shutdown('unhandledRejection');
});

// Run
main().catch(async (err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  log.error('Startup error', { error: error.message });
  // Clean up any partially initialized resources
  if (channelLifecycle) {
    try {
      await channelLifecycle.stop();
    } catch {
      /* ignore cleanup errors */
    }
  }
  process.exit(1);
});
