/**
 * ToolSummarizer - Detects and summarizes tool calls in conversation turns
 *
 * Tool calls in Claude conversations appear in various formats. This module
 * detects them and provides summarized forms for token estimation, reducing
 * verbose tool outputs to compact summaries.
 *
 * AC: @mem-turn-selection ac-2 - Summarized form tokens used for estimation
 * AC: @mem-turn-selection ac-4 - Correctly identifies tool name and extracts brief result
 *
 * @see @mem-turn-selection
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Detected tool call information
 */
export interface DetectedToolCall {
  /** Tool name (e.g., 'Read', 'Bash', 'Grep') */
  toolName: string;
  /** Brief description of the action */
  action: string;
  /** Brief result or status */
  result: string;
  /** Original content length in characters */
  originalLength: number;
}

/**
 * Tool summarization result
 */
export interface ToolSummary {
  /** Whether the content contained tool calls */
  isToolCall: boolean;
  /** Detected tool calls (if any) */
  toolCalls: DetectedToolCall[];
  /** Summarized content */
  summarized: string;
  /** Original content length */
  originalLength: number;
  /** Summarized content length */
  summarizedLength: number;
  /** Token savings estimate (0-1) */
  savingsRatio: number;
}

// ============================================================================
// Tool Detection Patterns
// ============================================================================

/**
 * Pattern for XML-style function calls with invoke tags
 */
const XML_INVOKE_PATTERN = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/antml:invoke>/g;

/**
 * Pattern for function_calls block wrapper
 */
const FUNCTION_CALLS_PATTERN = /<function_calls>([\s\S]*?)<\/antml:function_calls>/g;

/**
 * Pattern for parameter extraction
 */
const PARAMETER_PATTERN = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/antml:parameter>/g;

/**
 * Pattern for function results
 */
const FUNCTION_RESULTS_PATTERN = /<function_results>([\s\S]*?)<\/function_results>/g;

/**
 * Pattern for file content with line numbers (Read tool output)
 */
const LINE_NUMBER_PATTERN = /^\s*\d+[→|:│]\s*.+$/m;

/**
 * Pattern for "Found N files" (Grep/Glob output)
 */
const FOUND_FILES_PATTERN = /^(?:Found \d+ files?|No files found)/m;

// ============================================================================
// ToolSummarizer Implementation
// ============================================================================

/**
 * ToolSummarizer detects and summarizes tool calls for token estimation.
 *
 * Detects:
 * - XML-style function calls with invoke tags
 * - Function results blocks
 * - Tool output patterns (file contents, search results)
 *
 * Provides compact summaries that preserve semantic meaning while
 * dramatically reducing token count.
 */
export class ToolSummarizer {
  /**
   * Check if content contains tool call markers.
   *
   * AC: @mem-turn-selection ac-4 - Detects tool call patterns
   *
   * @param content - Content to check
   * @returns True if tool calls are detected
   */
  isToolCall(content: string): boolean {
    // Check for XML-style function calls
    if (content.includes('<function_calls>') || content.includes('<invoke')) {
      return true;
    }

    // Check for function results
    if (content.includes('<function_results>')) {
      return true;
    }

    // Check for file content with line numbers (Read output)
    if (LINE_NUMBER_PATTERN.test(content)) {
      const lineCount = content.split('\n').filter((l) => /^\s*\d+[→|:│]/.test(l)).length;
      // Only consider it tool output if substantial (> 3 lines)
      if (lineCount > 3) {
        return true;
      }
    }

    // Check for search results
    if (FOUND_FILES_PATTERN.test(content)) {
      return true;
    }

    return false;
  }

  /**
   * Summarize content, detecting and compacting tool calls.
   *
   * AC: @mem-turn-selection ac-2 - Provides summarized form for token estimation
   * AC: @mem-turn-selection ac-4 - Extracts tool name and brief result
   *
   * @param content - Content to summarize
   * @returns Tool summary with detected calls and compact representation
   */
  summarize(content: string): ToolSummary {
    const originalLength = content.length;
    const toolCalls: DetectedToolCall[] = [];

    // Process XML-style function calls
    const functionCallMatches = this.extractFunctionCalls(content);
    toolCalls.push(...functionCallMatches);

    // Process function results
    const resultMatches = this.extractFunctionResults(content);
    toolCalls.push(...resultMatches);

    // If no XML patterns, check for tool output patterns
    if (toolCalls.length === 0) {
      const outputMatch = this.detectToolOutput(content);
      if (outputMatch) {
        toolCalls.push(outputMatch);
      }
    }

    // Build summarized content
    const isToolCall = toolCalls.length > 0;
    const summarized = isToolCall ? this.buildSummary(toolCalls) : content;

    const summarizedLength = summarized.length;
    const savingsRatio = originalLength > 0 ? 1 - summarizedLength / originalLength : 0;

    return {
      isToolCall,
      toolCalls,
      summarized,
      originalLength,
      summarizedLength,
      savingsRatio: Math.max(0, savingsRatio),
    };
  }

  /**
   * Estimate token savings from summarization.
   *
   * @param original - Original content
   * @param summarized - Summarized content
   * @param charsPerToken - Characters per token estimate (default: 4)
   * @returns Estimated token savings (positive = tokens saved)
   */
  estimateTokenSavings(original: string, summarized: string, charsPerToken = 4): number {
    const originalTokens = Math.ceil(original.length / charsPerToken);
    const summarizedTokens = Math.ceil(summarized.length / charsPerToken);
    return originalTokens - summarizedTokens;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Extract tool calls from XML-style function_calls blocks.
   */
  private extractFunctionCalls(content: string): DetectedToolCall[] {
    const calls: DetectedToolCall[] = [];

    // Reset regex state
    FUNCTION_CALLS_PATTERN.lastIndex = 0;

    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = FUNCTION_CALLS_PATTERN.exec(content)) !== null) {
      const blockContent = blockMatch[1];

      // Extract individual invoke tags
      XML_INVOKE_PATTERN.lastIndex = 0;
      let invokeMatch: RegExpExecArray | null;
      while ((invokeMatch = XML_INVOKE_PATTERN.exec(blockContent)) !== null) {
        const toolName = invokeMatch[1];
        const invokeContent = invokeMatch[2];

        // Extract parameters for action description
        const params = this.extractParameters(invokeContent);
        const action = this.describeAction(toolName, params);

        calls.push({
          toolName,
          action,
          result: '(pending)',
          originalLength: invokeMatch[0].length,
        });
      }
    }

    return calls;
  }

  /**
   * Extract parameters from invoke content.
   */
  private extractParameters(content: string): Map<string, string> {
    const params = new Map<string, string>();

    PARAMETER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PARAMETER_PATTERN.exec(content)) !== null) {
      const name = match[1];
      const value = match[2].trim();
      params.set(name, value);
    }

    return params;
  }

  /**
   * Extract function results blocks.
   */
  private extractFunctionResults(content: string): DetectedToolCall[] {
    const results: DetectedToolCall[] = [];

    FUNCTION_RESULTS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FUNCTION_RESULTS_PATTERN.exec(content)) !== null) {
      const resultContent = match[1].trim();
      const brief = this.summarizeResult(resultContent);

      results.push({
        toolName: 'Result',
        action: '',
        result: brief,
        originalLength: match[0].length,
      });
    }

    return results;
  }

  /**
   * Detect tool output patterns that aren't in XML format.
   */
  private detectToolOutput(content: string): DetectedToolCall | null {
    // Check for file content with line numbers
    if (LINE_NUMBER_PATTERN.test(content)) {
      const lines = content.split('\n');
      const numberedLines = lines.filter((l) => /^\s*\d+[→|:│]/.test(l));
      if (numberedLines.length > 3) {
        return {
          toolName: 'Read',
          action: 'File content',
          result: `(${numberedLines.length} lines)`,
          originalLength: content.length,
        };
      }
    }

    // Check for search results
    const foundMatch = content.match(/^Found (\d+) files?/m);
    if (foundMatch) {
      return {
        toolName: 'Search',
        action: 'File search',
        result: `(${foundMatch[1]} files found)`,
        originalLength: content.length,
      };
    }

    if (/^No files found/m.test(content)) {
      return {
        toolName: 'Search',
        action: 'File search',
        result: '(no matches)',
        originalLength: content.length,
      };
    }

    return null;
  }

  /**
   * Create action description from tool name and parameters.
   */
  private describeAction(toolName: string, params: Map<string, string>): string {
    switch (toolName) {
      case 'Read': {
        const filePath = params.get('file_path') ?? '';
        const fileName = filePath.split('/').pop() ?? filePath;
        return `Read: ${fileName}`;
      }
      case 'Write': {
        const filePath = params.get('file_path') ?? '';
        const fileName = filePath.split('/').pop() ?? filePath;
        return `Write: ${fileName}`;
      }
      case 'Edit': {
        const filePath = params.get('file_path') ?? '';
        const fileName = filePath.split('/').pop() ?? filePath;
        return `Edit: ${fileName}`;
      }
      case 'Bash': {
        const command = params.get('command') ?? '';
        const brief = command.split('\n')[0].slice(0, 50);
        return `Bash: ${brief}${command.length > 50 ? '...' : ''}`;
      }
      case 'Grep': {
        const pattern = params.get('pattern') ?? '';
        const path = params.get('path') ?? '.';
        return `Grep: "${pattern}" in ${path}`;
      }
      case 'Glob': {
        const pattern = params.get('pattern') ?? '';
        return `Glob: ${pattern}`;
      }
      case 'Task': {
        const desc = params.get('description') ?? '';
        return `Task: ${desc}`;
      }
      case 'WebFetch': {
        const url = params.get('url') ?? '';
        try {
          const hostname = new URL(url).hostname;
          return `WebFetch: ${hostname}`;
        } catch {
          return `WebFetch: ${url.slice(0, 30)}`;
        }
      }
      case 'WebSearch': {
        const query = params.get('query') ?? '';
        return `WebSearch: "${query}"`;
      }
      default:
        return toolName;
    }
  }

  /**
   * Summarize result content to brief form.
   */
  private summarizeResult(content: string): string {
    // If content is small, keep as-is
    if (content.length <= 100) {
      return content;
    }

    // Count lines for file content
    const lines = content.split('\n');
    if (lines.length > 5) {
      // Check if it looks like file content
      const numberedLines = lines.filter((l) => /^\s*\d+[→|:│]/.test(l)).length;
      if (numberedLines > 3) {
        return `(${numberedLines} lines of file content)`;
      }
    }

    // Check for common result patterns
    if (content.includes('File created') || content.includes('successfully')) {
      return '(success)';
    }

    if (content.includes('error') || content.includes('Error') || content.includes('failed')) {
      const firstLine = lines[0].slice(0, 80);
      return `(error: ${firstLine})`;
    }

    if (content.includes('Found ')) {
      const match = content.match(/Found (\d+)/);
      if (match) {
        return `(${match[1]} results)`;
      }
    }

    // Default: truncate
    return `(${content.slice(0, 60).replace(/\n/g, ' ')}...)`;
  }

  /**
   * Build compact summary string from detected tool calls.
   */
  private buildSummary(calls: DetectedToolCall[]): string {
    const parts: string[] = [];

    for (const call of calls) {
      if (call.toolName === 'Result') {
        parts.push(`Result: ${call.result}`);
      } else {
        parts.push(`[Tool: ${call.toolName}] ${call.action}`);
        if (call.result && call.result !== '(pending)') {
          parts.push(`Result: ${call.result}`);
        }
      }
    }

    return parts.join('\n');
  }
}
