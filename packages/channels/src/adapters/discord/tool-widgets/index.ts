/**
 * Tool Widgets Module - Rich Discord embeds for agent tool calls
 *
 * @see @discord-tool-widgets
 */

export { ToolWidgetBuilder } from './ToolWidgetBuilder.js';
export type { WidgetResult } from './ToolWidgetBuilder.js';

export { ToolCallTracker } from './ToolCallTracker.js';
export type { ToolCallState, MessageState } from './ToolCallTracker.js';

export { MessageUpdateBatcher } from './MessageUpdateBatcher.js';
export type { MessageEditFn } from './MessageUpdateBatcher.js';

export { ThreadTracker } from './ThreadTracker.js';
export type { ThreadState } from './ThreadTracker.js';
