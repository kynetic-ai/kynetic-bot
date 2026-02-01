/**
 * CondensedToolDisplay Tests
 *
 * Tests for condensed tool display mode in DMs and fallback scenarios.
 * AC: @discord-tool-widgets ac-18, ac-19, ac-20
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CondensedToolDisplay,
  type CondensedToolCall,
} from '../../../../src/adapters/discord/tool-widgets/CondensedToolDisplay.js';

describe('CondensedToolDisplay', () => {
  let display: CondensedToolDisplay;

  beforeEach(() => {
    display = new CondensedToolDisplay();
  });

  const createToolCall = (
    id: string,
    name = 'bash',
    status: CondensedToolCall['status'] = 'in_progress'
  ): CondensedToolCall => ({
    toolCallId: id,
    toolName: name,
    status,
  });

  describe('addToolCall()', () => {
    // AC: @discord-tool-widgets ac-18 - First 5 tools shown as full widgets
    it('should return widget for first 5 tools', () => {
      for (let i = 1; i <= 5; i++) {
        const result = display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
        expect(result).toBe('widget');
      }

      const state = display.getState('session-1', 'channel-1');
      expect(state?.visibleTools).toHaveLength(5);
      expect(state?.condensedTools).toHaveLength(0);
    });

    // AC: @discord-tool-widgets ac-18 - 6th+ condensed into status message
    it('should return condensed for 6th+ tools', () => {
      // Add first 5 as widgets
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }

      // 6th should be condensed
      const result = display.addToolCall('session-1', 'channel-1', createToolCall('tool-6'));
      expect(result).toBe('condensed');

      const state = display.getState('session-1', 'channel-1');
      expect(state?.visibleTools).toHaveLength(5);
      expect(state?.condensedTools).toHaveLength(1);
    });

    it('should be idempotent for duplicate tool calls', () => {
      const tool = createToolCall('tool-1');

      const result1 = display.addToolCall('session-1', 'channel-1', tool);
      const result2 = display.addToolCall('session-1', 'channel-1', tool);

      expect(result1).toBe('widget');
      expect(result2).toBe('widget');

      const state = display.getState('session-1', 'channel-1');
      expect(state?.visibleTools).toHaveLength(1);
    });

    it('should isolate state by session', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));
      display.addToolCall('session-2', 'channel-1', createToolCall('tool-2'));

      expect(display.getState('session-1', 'channel-1')?.visibleTools).toHaveLength(1);
      expect(display.getState('session-2', 'channel-1')?.visibleTools).toHaveLength(1);
    });

    it('should isolate state by channel', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));
      display.addToolCall('session-1', 'channel-2', createToolCall('tool-2'));

      expect(display.getState('session-1', 'channel-1')?.visibleTools).toHaveLength(1);
      expect(display.getState('session-1', 'channel-2')?.visibleTools).toHaveLength(1);
    });
  });

  describe('updateToolCall()', () => {
    // AC: @discord-tool-widgets ac-20 - Status updates when condensed tool completes
    it('should update visible tool status', () => {
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-1', 'bash', 'in_progress')
      );

      const updated = display.updateToolCall('session-1', 'channel-1', 'tool-1', 'completed');

      expect(updated).toBe(true);
      const state = display.getState('session-1', 'channel-1');
      expect(state?.visibleTools[0]?.status).toBe('completed');
    });

    // AC: @discord-tool-widgets ac-20
    it('should update condensed tool status', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add condensed
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-6', 'read', 'in_progress')
      );

      const updated = display.updateToolCall('session-1', 'channel-1', 'tool-6', 'completed');

      expect(updated).toBe(true);
      const state = display.getState('session-1', 'channel-1');
      expect(state?.condensedTools[0]?.status).toBe('completed');
    });

    it('should return false for non-existent tool', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      const updated = display.updateToolCall('session-1', 'channel-1', 'non-existent', 'completed');

      expect(updated).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const updated = display.updateToolCall('session-1', 'channel-1', 'tool-1', 'completed');

      expect(updated).toBe(false);
    });
  });

  describe('isCondensed()', () => {
    it('should return false for visible tools', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      expect(display.isCondensed('session-1', 'channel-1', 'tool-1')).toBe(false);
    });

    it('should return true for condensed tools', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add condensed
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-6'));

      expect(display.isCondensed('session-1', 'channel-1', 'tool-6')).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(display.isCondensed('session-1', 'channel-1', 'tool-1')).toBe(false);
    });
  });

  describe('hasCondensedTools()', () => {
    it('should return false when no tools', () => {
      expect(display.hasCondensedTools('session-1', 'channel-1')).toBe(false);
    });

    it('should return false when only visible tools', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      expect(display.hasCondensedTools('session-1', 'channel-1')).toBe(false);
    });

    it('should return true when condensed tools exist', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add condensed
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-6'));

      expect(display.hasCondensedTools('session-1', 'channel-1')).toBe(true);
    });
  });

  describe('getStatusText()', () => {
    // AC: @discord-tool-widgets ac-19 - Progressive names for small overflow
    it('should return null when no condensed tools', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      expect(display.getStatusText('session-1', 'channel-1')).toBeNull();
    });

    // AC: @discord-tool-widgets ac-19 - Progressive names
    it('should show progressive names for small overflow (<=3 condensed)', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add 2 condensed
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-6', 'read', 'in_progress')
      );
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-7', 'write', 'in_progress')
      );

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('+ read, write running...');
    });

    // AC: @discord-tool-widgets ac-19 - Status icons in progressive names
    it('should show status icons in progressive names', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add condensed with different statuses
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-6', 'read', 'completed'));
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-7', 'write', 'failed'));
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-8', 'edit', 'in_progress')
      );

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('+ read ✓, write ✗, edit running...');
    });

    // AC: @discord-tool-widgets ac-19 - Counts when >8 total
    it('should show counts when total tools >8', () => {
      // Add 5 visible (3 completed, 2 running)
      for (let i = 1; i <= 3; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'bash', 'completed')
        );
      }
      for (let i = 4; i <= 5; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'read', 'in_progress')
        );
      }
      // Add 4 condensed (makes 9 total > 8)
      for (let i = 6; i <= 9; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'write', 'in_progress')
        );
      }

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('3 completed, 6 running');
    });

    // AC: @discord-tool-widgets ac-19 - Counts when >3 condensed
    it('should show counts when condensed tools >3', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'bash', 'completed')
        );
      }
      // Add 4 condensed (>3 triggers count mode)
      for (let i = 6; i <= 9; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'write', 'in_progress')
        );
      }

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('5 completed, 4 running');
    });

    it('should include failed count when there are failures', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall(
          'session-1',
          'channel-1',
          createToolCall(`tool-${i}`, 'bash', 'completed')
        );
      }
      // Add 4 condensed with some failures
      display.addToolCall(
        'session-1',
        'channel-1',
        createToolCall('tool-6', 'read', 'in_progress')
      );
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-7', 'write', 'failed'));
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-8', 'edit', 'failed'));
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-9', 'glob', 'completed'));

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('6 completed, 1 running, 2 failed');
    });

    it('should handle all completed with no running suffix in progressive mode', () => {
      // Add 5 visible
      for (let i = 1; i <= 5; i++) {
        display.addToolCall('session-1', 'channel-1', createToolCall(`tool-${i}`));
      }
      // Add 2 condensed, both completed
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-6', 'read', 'completed'));
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-7', 'write', 'completed'));

      const status = display.getStatusText('session-1', 'channel-1');

      expect(status).toBe('+ read ✓, write ✓');
    });

    it('should return null for non-existent session', () => {
      expect(display.getStatusText('session-1', 'channel-1')).toBeNull();
    });
  });

  describe('statusMessageId management', () => {
    it('should store and retrieve status message ID', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      display.setStatusMessageId('session-1', 'channel-1', 'msg-123');

      expect(display.getStatusMessageId('session-1', 'channel-1')).toBe('msg-123');
    });

    it('should return null when no status message set', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      expect(display.getStatusMessageId('session-1', 'channel-1')).toBeNull();
    });

    it('should return null for non-existent session', () => {
      expect(display.getStatusMessageId('session-1', 'channel-1')).toBeNull();
    });
  });

  describe('cleanupSession()', () => {
    it('should remove all state for session', () => {
      // Create state in multiple channels for session-1
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));
      display.addToolCall('session-1', 'channel-2', createToolCall('tool-2'));

      // Create state for session-2
      display.addToolCall('session-2', 'channel-1', createToolCall('tool-3'));

      display.cleanupSession('session-1');

      expect(display.getState('session-1', 'channel-1')).toBeUndefined();
      expect(display.getState('session-1', 'channel-2')).toBeUndefined();
      expect(display.getState('session-2', 'channel-1')).toBeDefined();
    });

    it('should handle cleanup of non-existent session', () => {
      // Should not throw
      display.cleanupSession('non-existent');
    });
  });

  describe('getState()', () => {
    it('should return undefined for non-existent state', () => {
      expect(display.getState('session-1', 'channel-1')).toBeUndefined();
    });

    it('should return state with correct structure', () => {
      display.addToolCall('session-1', 'channel-1', createToolCall('tool-1'));

      const state = display.getState('session-1', 'channel-1');

      expect(state).toEqual({
        sessionId: 'session-1',
        channelId: 'channel-1',
        visibleTools: [{ toolCallId: 'tool-1', toolName: 'bash', status: 'in_progress' }],
        condensedTools: [],
        statusMessageId: null,
      });
    });
  });
});
