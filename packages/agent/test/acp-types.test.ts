/**
 * Tests for ACP JSON-RPC type definitions and type guards
 */

import { describe, expect, it } from 'vitest';
import {
  isError,
  isNotification,
  isRequest,
  isResponse,
  JsonRpcException,
} from '../src/acp/types.js';

describe('JSON-RPC Type Guards', () => {
  describe('isRequest', () => {
    it('should return true for valid request with string id', () => {
      const request = {
        jsonrpc: '2.0',
        id: 'abc-123',
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(true);
    });

    it('should return true for valid request with number id', () => {
      const request = {
        jsonrpc: '2.0',
        id: 42,
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(true);
    });

    it('should return true for request with params', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
        params: { foo: 'bar' },
      };
      expect(isRequest(request)).toBe(true);
    });

    it('should return false for wrong jsonrpc version', () => {
      const request = {
        jsonrpc: '1.0',
        id: 1,
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for missing jsonrpc', () => {
      const request = {
        id: 1,
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for missing id', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for null id', () => {
      const request = {
        jsonrpc: '2.0',
        id: null,
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for missing method', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for non-string method', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 123,
      };
      expect(isRequest(request)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(isRequest(null)).toBe(false);
      expect(isRequest(undefined)).toBe(false);
      expect(isRequest('string')).toBe(false);
      expect(isRequest(123)).toBe(false);
      expect(isRequest([])).toBe(false);
    });
  });

  describe('isResponse', () => {
    it('should return true for valid response with string id', () => {
      const response = {
        jsonrpc: '2.0',
        id: 'abc-123',
        result: { data: 'test' },
      };
      expect(isResponse(response)).toBe(true);
    });

    it('should return true for valid response with number id', () => {
      const response = {
        jsonrpc: '2.0',
        id: 42,
        result: null,
      };
      expect(isResponse(response)).toBe(true);
    });

    it('should return true for response with primitive result', () => {
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: 'string' })).toBe(true);
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: 123 })).toBe(true);
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: true })).toBe(true);
      expect(isResponse({ jsonrpc: '2.0', id: 1, result: null })).toBe(true);
    });

    it('should return false for wrong jsonrpc version', () => {
      const response = {
        jsonrpc: '1.0',
        id: 1,
        result: {},
      };
      expect(isResponse(response)).toBe(false);
    });

    it('should return false for missing result', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
      };
      expect(isResponse(response)).toBe(false);
    });

    it('should return false when error is present', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: {},
        error: { code: -32600, message: 'error' },
      };
      expect(isResponse(response)).toBe(false);
    });

    it('should return false for missing id', () => {
      const response = {
        jsonrpc: '2.0',
        result: {},
      };
      expect(isResponse(response)).toBe(false);
    });

    it('should return false for null id', () => {
      const response = {
        jsonrpc: '2.0',
        id: null,
        result: {},
      };
      expect(isResponse(response)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(isResponse(null)).toBe(false);
      expect(isResponse(undefined)).toBe(false);
      expect(isResponse('string')).toBe(false);
    });
  });

  describe('isError', () => {
    it('should return true for valid error with string id', () => {
      const error = {
        jsonrpc: '2.0',
        id: 'abc-123',
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };
      expect(isError(error)).toBe(true);
    });

    it('should return true for valid error with number id', () => {
      const error = {
        jsonrpc: '2.0',
        id: 42,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      };
      expect(isError(error)).toBe(true);
    });

    it('should return true for valid error with null id', () => {
      const error = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
        },
      };
      expect(isError(error)).toBe(true);
    });

    it('should return true for error with data field', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { param: 'foo' },
        },
      };
      expect(isError(error)).toBe(true);
    });

    it('should return false for wrong jsonrpc version', () => {
      const error = {
        jsonrpc: '1.0',
        id: 1,
        error: { code: -32600, message: 'error' },
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for missing error field', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for non-object error field', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: 'not an object',
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for missing error code', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { message: 'error' },
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for non-number error code', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: 'not a number', message: 'error' },
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for missing error message', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600 },
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for non-string error message', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 123 },
      };
      expect(isError(error)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(isError(null)).toBe(false);
      expect(isError(undefined)).toBe(false);
      expect(isError('string')).toBe(false);
    });
  });

  describe('isNotification', () => {
    it('should return true for valid notification', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'test/notify',
      };
      expect(isNotification(notification)).toBe(true);
    });

    it('should return true for notification with params', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'test/notify',
        params: { data: 'test' },
      };
      expect(isNotification(notification)).toBe(true);
    });

    it('should return false for wrong jsonrpc version', () => {
      const notification = {
        jsonrpc: '1.0',
        method: 'test/notify',
      };
      expect(isNotification(notification)).toBe(false);
    });

    it('should return false for missing method', () => {
      const notification = {
        jsonrpc: '2.0',
      };
      expect(isNotification(notification)).toBe(false);
    });

    it('should return false for non-string method', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 123,
      };
      expect(isNotification(notification)).toBe(false);
    });

    it('should return false when id is present', () => {
      const notification = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test/notify',
      };
      expect(isNotification(notification)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(isNotification(null)).toBe(false);
      expect(isNotification(undefined)).toBe(false);
      expect(isNotification('string')).toBe(false);
    });
  });

  describe('Type guard mutual exclusivity', () => {
    it('should not match request as response, error, or notification', () => {
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
      };
      expect(isRequest(request)).toBe(true);
      expect(isResponse(request)).toBe(false);
      expect(isError(request)).toBe(false);
      expect(isNotification(request)).toBe(false);
    });

    it('should not match response as request, error, or notification', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: {},
      };
      expect(isRequest(response)).toBe(false);
      expect(isResponse(response)).toBe(true);
      expect(isError(response)).toBe(false);
      expect(isNotification(response)).toBe(false);
    });

    it('should not match error as request, response, or notification', () => {
      const error = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'error' },
      };
      expect(isRequest(error)).toBe(false);
      expect(isResponse(error)).toBe(false);
      expect(isError(error)).toBe(true);
      expect(isNotification(error)).toBe(false);
    });

    it('should not match notification as request, response, or error', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'test/notify',
      };
      expect(isRequest(notification)).toBe(false);
      expect(isResponse(notification)).toBe(false);
      expect(isError(notification)).toBe(false);
      expect(isNotification(notification)).toBe(true);
    });
  });
});

describe('JsonRpcException', () => {
  it('should create exception with code and message', () => {
    const exception = new JsonRpcException(-32600, 'Invalid Request');
    expect(exception.code).toBe(-32600);
    expect(exception.message).toBe('Invalid Request');
    expect(exception.data).toBeUndefined();
    expect(exception.name).toBe('JsonRpcException');
  });

  it('should create exception with data', () => {
    const exception = new JsonRpcException(-32602, 'Invalid params', { param: 'foo' });
    expect(exception.code).toBe(-32602);
    expect(exception.message).toBe('Invalid params');
    expect(exception.data).toEqual({ param: 'foo' });
  });

  it('should extend Error', () => {
    const exception = new JsonRpcException(-32600, 'error');
    expect(exception).toBeInstanceOf(Error);
  });

  describe('toErrorObject', () => {
    it('should return error object without data', () => {
      const exception = new JsonRpcException(-32600, 'Invalid Request');
      expect(exception.toErrorObject()).toEqual({
        code: -32600,
        message: 'Invalid Request',
      });
    });

    it('should return error object with data', () => {
      const exception = new JsonRpcException(-32602, 'Invalid params', { param: 'foo' });
      expect(exception.toErrorObject()).toEqual({
        code: -32602,
        message: 'Invalid params',
        data: { param: 'foo' },
      });
    });

    it('should include undefined data when explicitly set', () => {
      // Note: undefined data should not be included in the error object
      const exception = new JsonRpcException(-32600, 'error', undefined);
      const errorObj = exception.toErrorObject();
      expect('data' in errorObj).toBe(false);
    });
  });
});
