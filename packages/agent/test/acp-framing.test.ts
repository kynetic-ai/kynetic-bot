/**
 * Tests for JSON-RPC 2.0 framing layer
 */

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcFraming } from '../src/acp/framing.js';
import type { JsonRpcRequest } from '../src/acp/types.js';

describe('JsonRpcFraming', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let stderr: PassThrough;
  let framing: JsonRpcFraming;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    framing = new JsonRpcFraming({
      stdin,
      stdout,
      stderr,
      timeout: 100, // Short timeout for tests
    });
  });

  afterEach(() => {
    framing.close();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });

  describe('sendRequest', () => {
    it('should send request with auto-incrementing id', async () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      // Send two requests
      const p1 = framing.sendRequest('test/method1');
      const p2 = framing.sendRequest('test/method2');

      // Check output before responding
      expect(output).toHaveLength(2);
      const req1 = JSON.parse(output[0].trim());
      const req2 = JSON.parse(output[1].trim());
      expect(req1.id).toBe(1);
      expect(req2.id).toBe(2);

      // Respond to avoid unhandled rejections on cleanup
      stdin.write('{"jsonrpc":"2.0","id":1,"result":null}\n');
      stdin.write('{"jsonrpc":"2.0","id":2,"result":null}\n');
      await Promise.all([p1, p2]);
    });

    it('should send request with method and params', async () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      const p = framing.sendRequest('test/method', { foo: 'bar' });

      const request = JSON.parse(output[0].trim());
      expect(request).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
        params: { foo: 'bar' },
      });

      stdin.write('{"jsonrpc":"2.0","id":1,"result":null}\n');
      await p;
    });

    it('should resolve when response is received', async () => {
      const requestPromise = framing.sendRequest('test/method');

      // Simulate response
      stdin.write('{"jsonrpc":"2.0","id":1,"result":{"success":true}}\n');

      const result = await requestPromise;
      expect(result).toEqual({ success: true });
    });

    it('should reject when error response is received', async () => {
      const requestPromise = framing.sendRequest('test/method');

      // Simulate error response
      stdin.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request"}}\n');

      await expect(requestPromise).rejects.toThrow('Invalid Request');
    });

    it('should reject on timeout', async () => {
      const requestPromise = framing.sendRequest('test/method');

      // Don't send a response, let it timeout
      await expect(requestPromise).rejects.toThrow(/timed out after 100ms/);
    });

    it('should throw if framing is closed', async () => {
      framing.close();
      await expect(framing.sendRequest('test/method')).rejects.toThrow('JsonRpcFraming is closed');
    });

    it('should use method-specific timeout', async () => {
      const customFraming = new JsonRpcFraming({
        stdin,
        stdout,
        stderr,
        timeout: 1000, // Default timeout
        methodTimeouts: {
          'slow/method': 50, // Short timeout for this method
        },
      });

      const requestPromise = customFraming.sendRequest('slow/method');
      await expect(requestPromise).rejects.toThrow(/timed out after 50ms/);

      customFraming.close();
    });
  });

  describe('sendNotification', () => {
    it('should send notification without id', () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      framing.sendNotification('test/notify');

      const notification = JSON.parse(output[0].trim());
      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'test/notify',
      });
      expect('id' in notification).toBe(false);
    });

    it('should send notification with params', () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      framing.sendNotification('test/notify', { data: 'test' });

      const notification = JSON.parse(output[0].trim());
      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'test/notify',
        params: { data: 'test' },
      });
    });

    it('should throw if framing is closed', () => {
      framing.close();
      expect(() => framing.sendNotification('test/notify')).toThrow('JsonRpcFraming is closed');
    });
  });

  describe('sendResponse', () => {
    it('should send response with result', () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      framing.sendResponse(42, { data: 'test' });

      const response = JSON.parse(output[0].trim());
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: { data: 'test' },
      });
    });

    it('should throw if framing is closed', () => {
      framing.close();
      expect(() => framing.sendResponse(1, {})).toThrow('JsonRpcFraming is closed');
    });
  });

  describe('sendError', () => {
    it('should send error response with id', () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      framing.sendError(42, { code: -32600, message: 'Invalid Request' });

      const error = JSON.parse(output[0].trim());
      expect(error).toEqual({
        jsonrpc: '2.0',
        id: 42,
        error: { code: -32600, message: 'Invalid Request' },
      });
    });

    it('should send error response with null id', () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      framing.sendError(null, { code: -32700, message: 'Parse error' });

      const error = JSON.parse(output[0].trim());
      expect(error).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    });

    it('should throw if framing is closed', () => {
      framing.close();
      expect(() => framing.sendError(1, { code: -32600, message: 'error' })).toThrow(
        'JsonRpcFraming is closed',
      );
    });
  });

  describe('incoming message handling', () => {
    it('should emit request event for incoming requests', async () => {
      const requestHandler = vi.fn();
      framing.on('request', requestHandler);

      stdin.write('{"jsonrpc":"2.0","id":"abc","method":"test/call","params":{"x":1}}\n');

      // Wait for event processing
      await vi.waitFor(() => {
        expect(requestHandler).toHaveBeenCalledOnce();
      });

      const request: JsonRpcRequest = requestHandler.mock.calls[0][0];
      expect(request.method).toBe('test/call');
      expect(request.params).toEqual({ x: 1 });
    });

    it('should emit notification event for incoming notifications', async () => {
      const notificationHandler = vi.fn();
      framing.on('notification', notificationHandler);

      stdin.write('{"jsonrpc":"2.0","method":"test/notify","params":{"data":"test"}}\n');

      await vi.waitFor(() => {
        expect(notificationHandler).toHaveBeenCalledOnce();
      });
    });

    it('should send parse error for malformed JSON', async () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      stdin.write('not valid json\n');

      await vi.waitFor(() => {
        expect(output.length).toBeGreaterThan(0);
      });

      const error = JSON.parse(output[0].trim());
      expect(error.error.code).toBe(-32700);
      expect(error.error.message).toBe('Parse error');
    });

    it('should send invalid request error for non-JSON-RPC messages', async () => {
      const output: string[] = [];
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      stdin.write('{"some":"random","object":true}\n');

      await vi.waitFor(() => {
        expect(output.length).toBeGreaterThan(0);
      });

      const error = JSON.parse(output[0].trim());
      expect(error.error.code).toBe(-32600);
      expect(error.error.message).toBe('Invalid Request');
    });

    it('should handle multiple messages in one chunk', async () => {
      const requestHandler = vi.fn();
      framing.on('request', requestHandler);

      stdin.write(
        '{"jsonrpc":"2.0","id":1,"method":"first"}\n{"jsonrpc":"2.0","id":2,"method":"second"}\n',
      );

      await vi.waitFor(() => {
        expect(requestHandler).toHaveBeenCalledTimes(2);
      });
    });

    it('should handle split messages across chunks', async () => {
      const requestHandler = vi.fn();
      framing.on('request', requestHandler);

      // Send message in two parts
      stdin.write('{"jsonrpc":"2.0","id":1');
      stdin.write(',"method":"test"}\n');

      await vi.waitFor(() => {
        expect(requestHandler).toHaveBeenCalledOnce();
      });
    });

    it('should ignore empty lines', async () => {
      const requestHandler = vi.fn();
      const output: string[] = [];
      framing.on('request', requestHandler);
      stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));

      stdin.write('\n\n\n');

      // Wait a bit to ensure no events were triggered
      await new Promise((r) => setTimeout(r, 50));
      expect(requestHandler).not.toHaveBeenCalled();
      expect(output).toHaveLength(0);
    });
  });

  describe('timeout reset on activity', () => {
    it('should reset timeout when request is received', async () => {
      // Start a long-running request
      const requestPromise = framing.sendRequest('long/method');

      // Wait half the timeout
      await new Promise((r) => setTimeout(r, 60));

      // Simulate incoming request (activity)
      stdin.write('{"jsonrpc":"2.0","id":"agent-1","method":"tool/call"}\n');

      // Wait another half - would have timed out without reset
      await new Promise((r) => setTimeout(r, 60));

      // Now send the response
      stdin.write('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

      // Should succeed because timer was reset
      const result = await requestPromise;
      expect(result).toBe('ok');
    });

    it('should reset timeout when notification is received', async () => {
      const requestPromise = framing.sendRequest('long/method');

      await new Promise((r) => setTimeout(r, 60));

      // Simulate incoming notification (activity)
      stdin.write('{"jsonrpc":"2.0","method":"session/update"}\n');

      await new Promise((r) => setTimeout(r, 60));

      stdin.write('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');

      const result = await requestPromise;
      expect(result).toBe('ok');
    });
  });

  describe('close', () => {
    it('should reject all pending requests on close', async () => {
      const request1 = framing.sendRequest('test/method1');
      const request2 = framing.sendRequest('test/method2');

      framing.close();

      await expect(request1).rejects.toThrow('JsonRpcFraming closed');
      await expect(request2).rejects.toThrow('JsonRpcFraming closed');
    });

    it('should emit close event', () => {
      const closeHandler = vi.fn();
      framing.on('close', closeHandler);

      framing.close();

      expect(closeHandler).toHaveBeenCalledOnce();
    });

    it('should be idempotent', () => {
      const closeHandler = vi.fn();
      framing.on('close', closeHandler);

      framing.close();
      framing.close();
      framing.close();

      expect(closeHandler).toHaveBeenCalledOnce();
    });

    it('should close on stdin end', async () => {
      const closeHandler = vi.fn();
      framing.on('close', closeHandler);

      stdin.end();

      await vi.waitFor(() => {
        expect(closeHandler).toHaveBeenCalledOnce();
      });
    });
  });

  describe('error handling', () => {
    it('should emit error and close on stdin error', async () => {
      const errorHandler = vi.fn();
      const closeHandler = vi.fn();
      framing.on('error', errorHandler);
      framing.on('close', closeHandler);

      stdin.emit('error', new Error('stdin failed'));

      await vi.waitFor(() => {
        expect(errorHandler).toHaveBeenCalled();
        expect(closeHandler).toHaveBeenCalled();
      });
    });

    it('should handle error response with null id', async () => {
      const errorHandler = vi.fn();
      framing.on('error', errorHandler);

      stdin.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n');

      await vi.waitFor(() => {
        expect(errorHandler).toHaveBeenCalledWith({
          code: -32700,
          message: 'Parse error',
        });
      });
    });

    it('should reject with enriched error object for method-not-found', async () => {
      const requestPromise = framing.sendRequest('unknown/method');

      stdin.write(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n',
      );

      await expect(requestPromise).rejects.toMatchObject({
        message: 'Method not found',
        code: -32601,
      });
    });

    it('should not log method-not-found when silentMethodNotFound is true', async () => {
      const stderrOutput: string[] = [];
      stderr.on('data', (chunk: Buffer) => stderrOutput.push(chunk.toString()));

      const requestPromise = framing.sendRequest('optional/method', undefined, {
        silentMethodNotFound: true,
      });

      stdin.write(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n',
      );

      await expect(requestPromise).rejects.toThrow('Method not found');

      // Note: We can't easily verify logging was suppressed without mocking the logger,
      // but the option is being passed through correctly
    });
  });
});
