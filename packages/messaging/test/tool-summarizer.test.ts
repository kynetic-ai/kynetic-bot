/**
 * ToolSummarizer Tests
 *
 * Tests for tool call detection and summarization.
 *
 * @see @mem-turn-selection
 */

import { describe, expect, it } from 'vitest';

import {
  ToolSummarizer,
  type DetectedToolCall,
  type ToolSummary,
} from '../src/context/tool-summarizer.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const SAMPLE_FUNCTION_CALL = `<function_calls>
<invoke name="Read">
<parameter name="file_path">/home/user/project/src/index.ts</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

const SAMPLE_FUNCTION_RESULT = `<function_results>
     1→import { App } from './app.js';
     2→import { Config } from './config.js';
     3→import { Logger } from './logger.js';
     4→
     5→const app = new App();
     6→const config = new Config();
     7→const logger = new Logger();
     8→
     9→app.start();
    10→logger.info('Application started');
</function_results>`;

const SAMPLE_BASH_CALL = `<function_calls>
<invoke name="Bash">
<parameter name="command">git status</antml:parameter>
<parameter name="description">Check git status</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

const SAMPLE_GREP_CALL = `<function_calls>
<invoke name="Grep">
<parameter name="pattern">interface.*Handler</antml:parameter>
<parameter name="path">/home/user/project/src</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

const SAMPLE_MULTI_TOOL_CALL = `<function_calls>
<invoke name="Read">
<parameter name="file_path">/path/to/file1.ts</antml:parameter>
</antml:invoke>
<invoke name="Grep">
<parameter name="pattern">export</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

const SAMPLE_FILE_CONTENT = `     1→/**
     2→ * Main application entry point
     3→ */
     4→
     5→import { createServer } from 'http';
     6→import { App } from './app.js';
     7→
     8→const server = createServer();
     9→const app = new App(server);
    10→
    11→server.listen(3000, () => {
    12→  console.log('Server running on port 3000');
    13→});`;

const SAMPLE_SEARCH_RESULT = `Found 5 files
/path/to/file1.ts
/path/to/file2.ts
/path/to/file3.ts
/path/to/file4.ts
/path/to/file5.ts`;

const PLAIN_TEXT_CONTENT = `Hello, I am working on implementing a new feature for the application.
This involves adding a new endpoint for user authentication.`;

// ============================================================================
// ToolSummarizer Tests
// ============================================================================

describe('ToolSummarizer', () => {
  const summarizer = new ToolSummarizer();

  describe('isToolCall', () => {
    // AC: @mem-turn-selection ac-4 - Tool detection
    it('detects XML-style function_calls', () => {
      expect(summarizer.isToolCall(SAMPLE_FUNCTION_CALL)).toBe(true);
    });

    // AC: @mem-turn-selection ac-4 - Tool detection
    it('detects function_results blocks', () => {
      expect(summarizer.isToolCall(SAMPLE_FUNCTION_RESULT)).toBe(true);
    });

    // AC: @mem-turn-selection ac-4 - Tool detection
    it('detects file content with line numbers', () => {
      expect(summarizer.isToolCall(SAMPLE_FILE_CONTENT)).toBe(true);
    });

    // AC: @mem-turn-selection ac-4 - Tool detection
    it('detects search results', () => {
      expect(summarizer.isToolCall(SAMPLE_SEARCH_RESULT)).toBe(true);
    });

    // AC: @mem-turn-selection ac-4 - No false positives
    it('returns false for plain text', () => {
      expect(summarizer.isToolCall(PLAIN_TEXT_CONTENT)).toBe(false);
    });

    // AC: @mem-turn-selection ac-4 - No false positives for small line-numbered content
    it('returns false for small line-numbered content (< 4 lines)', () => {
      const smallContent = `     1→line one
     2→line two
     3→line three`;
      expect(summarizer.isToolCall(smallContent)).toBe(false);
    });

    it('detects invoke tags without function_calls wrapper', () => {
      const invokeOnly = `<invoke name="Read">
<parameter name="file_path">/path/to/file.ts</antml:parameter>
</antml:invoke>`;
      expect(summarizer.isToolCall(invokeOnly)).toBe(true);
    });
  });

  describe('summarize', () => {
    // AC: @mem-turn-selection ac-2 - Summarized form for token estimation
    it('summarizes Read tool call', () => {
      const result = summarizer.summarize(SAMPLE_FUNCTION_CALL);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe('Read');
      expect(result.toolCalls[0].action).toContain('index.ts');
      expect(result.summarizedLength).toBeLessThan(result.originalLength);
    });

    // AC: @mem-turn-selection ac-4 - Extracts tool name and brief result
    it('extracts tool name from function results', () => {
      const result = summarizer.summarize(SAMPLE_FUNCTION_RESULT);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe('Result');
      expect(result.toolCalls[0].result).toContain('lines');
    });

    // AC: @mem-turn-selection ac-2 - Summarized form tokens used
    it('summarizes Bash tool call', () => {
      const result = summarizer.summarize(SAMPLE_BASH_CALL);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls[0].toolName).toBe('Bash');
      expect(result.toolCalls[0].action).toContain('git status');
    });

    // AC: @mem-turn-selection ac-2 - Summarized form tokens used
    it('summarizes Grep tool call', () => {
      const result = summarizer.summarize(SAMPLE_GREP_CALL);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls[0].toolName).toBe('Grep');
      expect(result.toolCalls[0].action).toContain('interface.*Handler');
    });

    // AC: @mem-turn-selection ac-4 - Handles multiple tool calls
    it('handles multiple tool calls in one block', () => {
      const result = summarizer.summarize(SAMPLE_MULTI_TOOL_CALL);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].toolName).toBe('Read');
      expect(result.toolCalls[1].toolName).toBe('Grep');
    });

    // AC: @mem-turn-selection ac-2 - Significant token savings
    it('achieves significant token savings for large tool output', () => {
      const result = summarizer.summarize(SAMPLE_FUNCTION_RESULT);

      expect(result.savingsRatio).toBeGreaterThan(0.5); // > 50% reduction
    });

    it('returns original content for non-tool content', () => {
      const result = summarizer.summarize(PLAIN_TEXT_CONTENT);

      expect(result.isToolCall).toBe(false);
      expect(result.summarized).toBe(PLAIN_TEXT_CONTENT);
      expect(result.savingsRatio).toBe(0);
    });

    // AC: @mem-turn-selection ac-4 - Detects search results
    it('summarizes search results', () => {
      const result = summarizer.summarize(SAMPLE_SEARCH_RESULT);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls[0].toolName).toBe('Search');
      expect(result.toolCalls[0].result).toContain('5');
    });

    it('handles "No files found" pattern', () => {
      const noFilesContent = `No files found
No matches for the pattern.`;

      const result = summarizer.summarize(noFilesContent);

      expect(result.isToolCall).toBe(true);
      expect(result.toolCalls[0].result).toContain('no matches');
    });
  });

  describe('estimateTokenSavings', () => {
    it('calculates token savings correctly', () => {
      const original = 'a'.repeat(1000); // ~250 tokens
      const summarized = 'b'.repeat(100); // ~25 tokens

      const savings = summarizer.estimateTokenSavings(original, summarized);

      // (1000/4) - (100/4) = 250 - 25 = 225
      expect(savings).toBe(225);
    });

    it('returns negative savings when summarized is larger', () => {
      const original = 'a'.repeat(100);
      const summarized = 'b'.repeat(200);

      const savings = summarizer.estimateTokenSavings(original, summarized);

      expect(savings).toBeLessThan(0);
    });

    it('uses custom charsPerToken', () => {
      const original = 'a'.repeat(100);
      const summarized = 'b'.repeat(50);

      // With charsPerToken = 2: (100/2) - (50/2) = 50 - 25 = 25
      const savings = summarizer.estimateTokenSavings(original, summarized, 2);

      expect(savings).toBe(25);
    });
  });

  describe('action descriptions', () => {
    it('extracts filename for Read tool', () => {
      const content = `<function_calls>
<invoke name="Read">
<parameter name="file_path">/home/user/project/deeply/nested/important-file.ts</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('important-file.ts');
    });

    it('extracts filename for Write tool', () => {
      const content = `<function_calls>
<invoke name="Write">
<parameter name="file_path">/path/to/output.json</antml:parameter>
<parameter name="content">{"key": "value"}</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('output.json');
    });

    it('extracts filename for Edit tool', () => {
      const content = `<function_calls>
<invoke name="Edit">
<parameter name="file_path">/path/to/source.ts</antml:parameter>
<parameter name="old_string">old</antml:parameter>
<parameter name="new_string">new</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('source.ts');
    });

    it('truncates long Bash commands', () => {
      const longCommand = 'git log --oneline --graph --all --decorate ' + 'x'.repeat(100);
      const content = `<function_calls>
<invoke name="Bash">
<parameter name="command">${longCommand}</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('...');
      expect(result.toolCalls[0].action.length).toBeLessThan(70);
    });

    it('extracts pattern and path for Glob tool', () => {
      const content = `<function_calls>
<invoke name="Glob">
<parameter name="pattern">**/*.test.ts</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('**/*.test.ts');
    });

    it('extracts description for Task tool', () => {
      const content = `<function_calls>
<invoke name="Task">
<parameter name="description">Find all test files</antml:parameter>
<parameter name="prompt">Search for test files in src/</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('Find all test files');
    });

    it('extracts hostname for WebFetch tool', () => {
      const content = `<function_calls>
<invoke name="WebFetch">
<parameter name="url">https://api.example.com/v1/users</antml:parameter>
<parameter name="prompt">Get user data</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('api.example.com');
    });

    it('extracts query for WebSearch tool', () => {
      const content = `<function_calls>
<invoke name="WebSearch">
<parameter name="query">TypeScript generic constraints</antml:parameter>
</antml:invoke>
</antml:function_calls>`;

      const result = summarizer.summarize(content);
      expect(result.toolCalls[0].action).toContain('TypeScript generic constraints');
    });
  });

  describe('result summarization', () => {
    it('keeps small results intact', () => {
      const smallResult = `<function_results>
File created successfully.
</function_results>`;

      const result = summarizer.summarize(smallResult);
      expect(result.toolCalls[0].result).toContain('File created');
    });

    it('detects success patterns', () => {
      const successResult = `<function_results>
The file has been created successfully at /path/to/file.ts
All changes have been written.
</function_results>`;

      const result = summarizer.summarize(successResult);
      expect(result.toolCalls[0].result).toContain('success');
    });

    it('detects error patterns', () => {
      const errorResult = `<function_results>
Error: File not found
The specified path does not exist.
Please check the file path and try again.
</function_results>`;

      const result = summarizer.summarize(errorResult);
      expect(result.toolCalls[0].result).toContain('Error');
    });

    it('summarizes Found N pattern', () => {
      const foundResult = `<function_results>
Found 42 matches in 15 files.
/path/to/file1.ts:10
/path/to/file2.ts:25
...more results...
</function_results>`;

      const result = summarizer.summarize(foundResult);
      expect(result.toolCalls[0].result).toContain('42');
    });
  });
});
