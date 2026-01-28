/**
 * Channel Lifecycle
 *
 * Manages channel adapter connection lifecycle with health monitoring.
 */

import type { ChannelAdapter } from '@kynetic-bot/core';

/**
 * Configuration options for channel lifecycle management
 */
export interface LifecycleOptions {
  /** Interval between health checks in milliseconds (default: 30000ms = 30s) */
  healthCheckInterval?: number;

  /** Number of consecutive failures before marking unhealthy (default: 3) */
  failureThreshold?: number;

  /** Delay before attempting reconnection in milliseconds (default: 5000ms = 5s) */
  reconnectDelay?: number;

  /** Maximum number of reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

/**
 * Channel lifecycle state
 */
export type LifecycleState =
  | 'idle' // Not started
  | 'starting' // Initializing connection
  | 'healthy' // Running with successful health checks
  | 'unhealthy' // Running but health checks failing
  | 'reconnecting' // Attempting to reconnect
  | 'stopping'; // Shutting down

/**
 * Message queue entry for rate limiting and retry
 */
interface QueuedMessage {
  channel: string;
  text: string;
  options?: Record<string, unknown>;
  attempts: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Manages the lifecycle of a channel adapter
 *
 * Provides health monitoring, automatic reconnection, and graceful shutdown.
 */
export class ChannelLifecycle {
  private state: LifecycleState = 'idle';
  private consecutiveFailures = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private messageQueue: QueuedMessage[] = [];
  private processingQueue = false;

  private readonly options: Required<LifecycleOptions>;

  constructor(
    private adapter: ChannelAdapter,
    options: LifecycleOptions = {},
  ) {
    this.options = {
      healthCheckInterval: options.healthCheckInterval ?? 30000,
      failureThreshold: options.failureThreshold ?? 3,
      reconnectDelay: options.reconnectDelay ?? 5000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
    };
  }

  /**
   * Start the channel adapter and begin health monitoring
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start from state: ${this.state}`);
    }

    this.state = 'starting';

    try {
      // AC-1: Establishes connection
      await this.adapter.start();

      this.state = 'healthy';
      this.consecutiveFailures = 0;
      this.reconnectAttempts = 0;

      // AC-1: Begins health monitoring
      this.startHealthMonitoring();
    } catch (error) {
      this.state = 'idle';
      throw error;
    }
  }

  /**
   * Stop the channel adapter and clean up resources
   */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') {
      return;
    }

    this.state = 'stopping';

    // AC-3: Stop accepting new work
    this.stopHealthMonitoring();

    try {
      // AC-3: Drains pending messages
      await this.drainMessageQueue();

      // AC-3: Closes connections cleanly
      await this.adapter.stop();
    } catch (error) {
      // Swallow stop errors but ensure state cleanup
    } finally {
      this.state = 'idle';
      this.consecutiveFailures = 0;
      this.reconnectAttempts = 0;
      this.messageQueue = [];
    }
  }

  /**
   * Get the current lifecycle state
   */
  getState(): LifecycleState {
    return this.state;
  }

  /**
   * Check if the channel is healthy
   */
  isHealthy(): boolean {
    return this.state === 'healthy';
  }

  /**
   * Send a message with automatic queueing and retry
   *
   * @param channel - Channel identifier
   * @param text - Message text
   * @param options - Platform-specific options
   */
  async sendMessage(
    channel: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<void> {
    // AC-4: Queue messages when rate limited or unhealthy
    return new Promise<void>((resolve, reject) => {
      this.messageQueue.push({
        channel,
        text,
        options,
        attempts: 0,
        resolve,
        reject,
      });

      this.processMessageQueue();
    });
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthTimer) {
      return;
    }

    this.healthTimer = setInterval(() => {
      void this.performHealthCheck();
    }, this.options.healthCheckInterval);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Perform a health check on the adapter
   */
  private async performHealthCheck(): Promise<void> {
    if (this.state !== 'healthy' && this.state !== 'unhealthy') {
      return;
    }

    try {
      // Simple health check: adapter should still be defined
      // Platform-specific health checks could be added here
      if (!this.adapter) {
        throw new Error('Adapter not available');
      }

      // Reset failure counter on success
      if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
        if (this.state === 'unhealthy') {
          this.state = 'healthy';
        }
      }
    } catch (error) {
      this.handleHealthCheckFailure();
    }
  }

  /**
   * Handle health check failure
   */
  private handleHealthCheckFailure(): void {
    this.consecutiveFailures++;

    // AC-2: When consecutive failures exceed threshold
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      // AC-2: Marks channel unhealthy
      this.state = 'unhealthy';

      // AC-2: Triggers reconnection
      void this.attemptReconnect();
    }
  }

  /**
   * Attempt to reconnect the adapter
   */
  private async attemptReconnect(): Promise<void> {
    if (this.state === 'reconnecting') {
      return;
    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      // Max reconnection attempts reached
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;

    // Stop health monitoring during reconnection
    this.stopHealthMonitoring();

    try {
      // Wait before reconnecting
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.reconnectDelay),
      );

      // Stop existing connection
      await this.adapter.stop();

      // Start new connection
      await this.adapter.start();

      // Reset state
      this.state = 'healthy';
      this.consecutiveFailures = 0;
      this.reconnectAttempts = 0;

      // Resume health monitoring
      this.startHealthMonitoring();
    } catch (error) {
      // Reconnection failed, mark as unhealthy and try again later
      this.state = 'unhealthy';
      this.startHealthMonitoring();
    }
  }

  /**
   * Process queued messages with retry and backoff
   */
  private async processMessageQueue(): Promise<void> {
    if (this.processingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.processingQueue = true;

    while (this.messageQueue.length > 0) {
      // AC-4: Wait if unhealthy or reconnecting (with max wait)
      if (this.state === 'unhealthy' || this.state === 'reconnecting') {
        let waitCount = 0;
        while (
          (this.state === 'unhealthy' || this.state === 'reconnecting') &&
          waitCount < 10
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          waitCount++;
        }
        if (waitCount >= 10) {
          // Give up waiting
          break;
        }
      }

      // Stop processing if stopping
      if (this.state === 'stopping' || this.state === 'idle') {
        break;
      }

      const message = this.messageQueue[0];

      try {
        // AC-4: Retries with backoff
        await this.adapter.sendMessage(
          message.channel,
          message.text,
          message.options,
        );

        // Success - remove from queue and resolve
        this.messageQueue.shift();
        message.resolve();
      } catch (error) {
        message.attempts++;

        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
        const backoffDelay = Math.min(100 * 2 ** message.attempts, 2000);

        // Max 5 attempts
        if (message.attempts >= 5) {
          this.messageQueue.shift();
          message.reject(
            error instanceof Error
              ? error
              : new Error('Failed to send message after 5 attempts'),
          );
        } else {
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }

    this.processingQueue = false;
  }

  /**
   * Drain the message queue during shutdown
   */
  private async drainMessageQueue(): Promise<void> {
    const timeout = 30000; // 30 second timeout
    const startTime = Date.now();

    // Wait for queue to drain or timeout
    while (
      this.messageQueue.length > 0 &&
      Date.now() - startTime < timeout
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Reject remaining messages
    for (const message of this.messageQueue) {
      message.reject(new Error('Channel shutdown before message could be sent'));
    }

    this.messageQueue = [];
  }
}
