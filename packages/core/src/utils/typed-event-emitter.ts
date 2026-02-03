/**
 * TypedEventEmitter - Type-safe event emitter
 *
 * Provides compile-time type safety for event names and payloads.
 * Extends Node.js EventEmitter with typed emit/on/off/once methods.
 *
 * @example
 * ```typescript
 * interface MyEvents {
 *   'user:login': (userId: string, timestamp: Date) => void;
 *   'user:logout': (userId: string) => void;
 *   error: (error: Error) => void;
 * }
 *
 * class MyClass extends TypedEventEmitter<MyEvents> {
 *   doSomething() {
 *     // Type-safe: correct event name and parameters
 *     this.emit('user:login', 'user123', new Date());
 *
 *     // Compile error: invalid event name
 *     this.emit('invalid', 'data');
 *
 *     // Compile error: wrong parameter types
 *     this.emit('user:login', 123, 'not-a-date');
 *   }
 * }
 *
 * const instance = new MyClass();
 * // Type-safe listener
 * instance.on('user:login', (userId, timestamp) => {
 *   // userId is inferred as string
 *   // timestamp is inferred as Date
 * });
 * ```
 */

import { EventEmitter } from 'node:events';

/**
 * Type helper to extract event names from event map
 */
type EventNames<T> = keyof T & (string | symbol);

/**
 * Type helper to extract parameters from event handler
 */
type EventParams<T, K extends EventNames<T>> = T[K] extends (...args: infer P) => void ? P : never;

/**
 * Type-safe EventEmitter base class
 *
 * Generic parameter T should be an interface mapping event names to handler signatures:
 * ```typescript
 * interface MyEvents {
 *   'event:name': (param1: Type1, param2: Type2) => void;
 * }
 * ```
 */
export class TypedEventEmitter<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic constraint requires any for maximum flexibility
  T extends Record<string, (...args: any[]) => void>,
> extends EventEmitter {
  /**
   * Emit a typed event
   *
   * @param event - Event name (type-checked against T)
   * @param args - Event arguments (type-checked against handler signature)
   * @returns true if event had listeners, false otherwise
   */
  emit<K extends EventNames<T>>(event: K, ...args: EventParams<T, K>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Add a typed event listener
   *
   * @param event - Event name (type-checked against T)
   * @param listener - Event handler (type-checked against handler signature)
   * @returns this (for chaining)
   */
  on<K extends EventNames<T>>(event: K, listener: T[K]): this;
  // Overload for backward compatibility with generic EventEmitter interfaces
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Backward compatibility with untyped EventEmitter requires any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Implementation signature requires any for overload resolution
  on(event: any, listener: any): this {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Overload implementation requires passing any to super
    return super.on(event, listener);
  }

  /**
   * Add a one-time typed event listener
   *
   * @param event - Event name (type-checked against T)
   * @param listener - Event handler (type-checked against handler signature)
   * @returns this (for chaining)
   */
  once<K extends EventNames<T>>(event: K, listener: T[K]): this {
    return super.once(event, listener);
  }

  /**
   * Remove a typed event listener
   *
   * @param event - Event name (type-checked against T)
   * @param listener - Event handler (type-checked against handler signature)
   * @returns this (for chaining)
   */
  off<K extends EventNames<T>>(event: K, listener: T[K]): this {
    return super.off(event, listener);
  }

  /**
   * Remove all listeners for a typed event, or all listeners if no event specified
   *
   * @param event - Optional event name (type-checked against T)
   * @returns this (for chaining)
   */
  removeAllListeners<K extends EventNames<T>>(event?: K): this {
    return super.removeAllListeners(event);
  }

  /**
   * Get all listeners for a typed event
   *
   * @param event - Event name (type-checked against T)
   * @returns Array of listeners
   */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- EventEmitter.listeners() returns Function[]
  listeners<K extends EventNames<T>>(event: K): Function[] {
    return super.listeners(event);
  }

  /**
   * Get listener count for a typed event
   *
   * @param event - Event name (type-checked against T)
   * @returns Number of listeners
   */
  listenerCount<K extends EventNames<T>>(event: K): number {
    return super.listenerCount(event);
  }
}
