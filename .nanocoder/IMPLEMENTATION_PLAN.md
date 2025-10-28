# Implementation Plan: Streaming with Token Batching

## Overview

This document outlines the phased implementation plan for adding real-time token streaming with intelligent batching to Nanocoder. The feature will provide users with immediate visual feedback during LLM response generation while maintaining terminal performance and preventing flickering.

## Goals

1. **Real-time responsiveness**: Show LLM output as it's generated, not after completion
2. **Performance**: Minimize React re-renders through intelligent token batching
3. **No flickering**: Maintain Ink's Static component design for historical messages
4. **Configurability**: Allow per-provider streaming enable/disable
5. **Backward compatibility**: Existing non-streaming behavior preserved when streaming disabled

## Success Criteria

- [ ] Streaming displays tokens within 100ms of generation
- [ ] Token batching reduces re-renders from ~100/response to ~10/response
- [ ] No terminal flickering for existing Static messages
- [ ] Per-provider configuration (`streaming: true/false`) works correctly
- [ ] Cancellation (Ctrl+C) works cleanly mid-stream with partial content displayed
- [ ] Tool calls detected correctly after streaming completes
- [ ] All existing tests pass
- [ ] New unit tests for streaming logic achieve >90% coverage

---

## Phase 1: Type System Updates (1-2 hours)

### 1.1 Update LLMClient Interface

**File**: `source/types/core.ts`

**Changes**:

```typescript
export interface LLMClient {
	getCurrentModel(): string;
	setModel(model: string): void;
	getContextSize(): number;
	getAvailableModels(): Promise<string[]>;

	// Add optional onToken callback parameter
	chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
		onToken?: (token: string) => void, // NEW
	): Promise<LLMChatResponse>;

	clearContext(): Promise<void>;
}
```

**Rationale**: Non-breaking change - `onToken` is optional. When undefined, clients behave as before (non-streaming).

### 1.2 Update Provider Configuration Types

**File**: `source/types/config.ts`

**Changes**:

```typescript
export interface LangChainProviderConfig {
	name: string;
	type: string;
	models: string[];
	requestTimeout?: number;
	socketTimeout?: number;
	streaming?: boolean; // NEW - default: true
	connectionPool?: {
		idleTimeout?: number;
		cumulativeMaxIdleTimeout?: number;
	};
	config: {
		baseURL?: string;
		apiKey?: string;
		[key: string]: unknown;
	};
}

export interface ProviderConfig {
	name: string;
	baseUrl?: string;
	apiKey?: string;
	models: string[];
	requestTimeout?: number;
	socketTimeout?: number;
	streaming?: boolean; // NEW - default: true
	organizationId?: string;
	timeout?: number;
	connectionPool?: {
		idleTimeout?: number;
		cumulativeMaxIdleTimeout?: number;
	};
	[key: string]: unknown;
}

export interface AppConfig {
	providers?: {
		name: string;
		baseUrl?: string;
		apiKey?: string;
		models: string[];
		requestTimeout?: number;
		socketTimeout?: number;
		streaming?: boolean; // NEW - default: true
		connectionPool?: {
			idleTimeout?: number;
			cumulativeMaxIdleTimeout?: number;
		};
		[key: string]: unknown;
	}[];
	mcpServers?: {
		name: string;
		command: string;
		args?: string[];
		env?: Record<string, string>;
	}[];
}
```

**Default Behavior**: If `streaming` is undefined, treat as `true` (opt-out model).

### Deliverables

- [ ] Updated type definitions in `source/types/core.ts`
- [ ] Updated type definitions in `source/types/config.ts`
- [ ] TypeScript compilation succeeds (`pnpm test:types`)

---

## Phase 2: Streaming Logic in LangGraphClient (3-4 hours)

### 2.1 Implement Token Batching Algorithm

**File**: `source/langgraph-client.ts`

**New Constants**:

```typescript
export class LangGraphClient implements LLMClient {
	// ... existing fields ...

	// Token batching configuration
	private readonly TOKEN_BATCH_INTERVAL_MS = 75;  // ~13 FPS, smooth animation
	private readonly TOKEN_BATCH_SIZE = 10;         // Flush every 10 tokens
```

**New Helper Function**:

```typescript
private createTokenBatcher(onToken: (token: string) => void) {
	let tokenBuffer = '';
	let tokenCount = 0;
	let lastEmitTime = Date.now();
	let flushTimer: NodeJS.Timeout | null = null;

	const flush = () => {
		if (tokenBuffer) {
			onToken(tokenBuffer);
			tokenBuffer = '';
			tokenCount = 0;
		}
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	};

	const handleToken = (token: string) => {
		tokenBuffer += token;
		tokenCount++;

		const now = Date.now();
		const timeSinceLastEmit = now - lastEmitTime;

		// Flush if count threshold OR time threshold met
		if (
			tokenCount >= this.TOKEN_BATCH_SIZE ||
			timeSinceLastEmit >= this.TOKEN_BATCH_INTERVAL_MS
		) {
			flush();
			lastEmitTime = now;
		} else if (!flushTimer) {
			// Schedule flush for remaining time
			const remainingTime = this.TOKEN_BATCH_INTERVAL_MS - timeSinceLastEmit;
			flushTimer = setTimeout(() => {
				flush();
				lastEmitTime = Date.now();
			}, remainingTime);
		}
	};

	return { handleToken, flush };
}
```

### 2.2 Update chat() Method

**File**: `source/langgraph-client.ts` (lines 290-392)

**Changes**:

```typescript
async chat(
	messages: Message[],
	tools: Tool[],
	signal?: AbortSignal,
	onToken?: (token: string) => void,  // NEW parameter
): Promise<LLMChatResponse> {
	if (signal?.aborted) {
		throw new Error('Operation was cancelled');
	}

	try {
		const langchainMessages = messages.map(convertToLangChainMessage);
		let result: AIMessage;

		// Check if streaming is enabled for this provider
		const streamingEnabled =
			this.providerConfig.streaming !== false && !!onToken;

		// Create invoke options
		const invokeOptions: any = { signal };

		// Set up streaming callback if enabled
		if (streamingEnabled) {
			const batcher = this.createTokenBatcher(onToken);

			invokeOptions.callbacks = [
				{
					handleLLMNewToken: (token: string) => {
						batcher.handleToken(token);
					},
				},
			];

			// Ensure final flush after invoke completes
			try {
				// Try to bind tools and invoke
				if (tools.length > 0) {
					try {
						const langchainTools = tools.map(tool => ({
							type: 'function' as const,
							function: {
								name: tool.function.name,
								description: tool.function.description,
								parameters: tool.function.parameters,
							},
						}));

						const modelWithTools = this.chatModel.bindTools(langchainTools, {
							parallel_tool_calls: false,
						});
						result = (await modelWithTools.invoke(
							langchainMessages,
							invokeOptions,
						)) as AIMessage;
					} catch {
						result = (await this.chatModel.invoke(
							langchainMessages,
							invokeOptions,
						)) as AIMessage;
					}
				} else {
					result = (await this.chatModel.invoke(
						langchainMessages,
						invokeOptions,
					)) as AIMessage;
				}

				// Flush any remaining tokens
				batcher.flush();
			} catch (error) {
				// Ensure flush even on error
				batcher.flush();
				throw error;
			}
		} else {
			// Non-streaming path (existing logic)
			if (tools.length > 0) {
				try {
					const langchainTools = tools.map(tool => ({
						type: 'function' as const,
						function: {
							name: tool.function.name,
							description: tool.function.description,
							parameters: tool.function.parameters,
						},
					}));

					const modelWithTools = this.chatModel.bindTools(langchainTools, {
						parallel_tool_calls: false,
					});
					result = (await modelWithTools.invoke(
						langchainMessages,
						invokeOptions,
					)) as AIMessage;
				} catch {
					result = (await this.chatModel.invoke(
						langchainMessages,
						invokeOptions,
					)) as AIMessage;
				}
			} else {
				result = (await this.chatModel.invoke(
					langchainMessages,
					invokeOptions,
				)) as AIMessage;
			}
		}

		// Convert and parse tool calls (existing logic)
		let convertedMessage = convertFromLangChainMessage(result);

		if (
			tools.length > 0 &&
			(!convertedMessage.tool_calls || convertedMessage.tool_calls.length === 0) &&
			convertedMessage.content
		) {
			const content = convertedMessage.content;

			if (XMLToolCallParser.hasToolCalls(content)) {
				const parsedToolCalls = XMLToolCallParser.parseToolCalls(content);
				const toolCalls = XMLToolCallParser.convertToToolCalls(parsedToolCalls);
				const cleanedContent =
					XMLToolCallParser.removeToolCallsFromContent(content);

				convertedMessage = {
					...convertedMessage,
					content: cleanedContent,
					tool_calls: toolCalls,
				};
			}
		}

		return {
			choices: [
				{
					message: {
						role: 'assistant' as const,
						content: convertedMessage.content,
						tool_calls: convertedMessage.tool_calls,
					},
				},
			],
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Operation was cancelled');
		}

		const userMessage = parseAPIError(error);
		throw new Error(userMessage);
	}
}
```

### Deliverables

- [ ] Token batching logic implemented in `LangGraphClient`
- [ ] Streaming respects `streaming: false` config
- [ ] Final flush called after streaming completes
- [ ] TypeScript compilation succeeds

---

## Phase 3: Chat Handler Streaming State (2 hours)

### 3.1 Add Streaming State

**File**: `source/hooks/useChatHandler.tsx`

**New State Variables**:

```typescript
// Add to existing state in useChatHandler
const [streamingContent, setStreamingContent] = React.useState('');
const [isStreaming, setIsStreaming] = React.useState(false);
```

### 3.2 Update Message Sending Logic

**File**: `source/hooks/useChatHandler.tsx`

**Changes to `handleChatMessage` function**:

```typescript
const handleChatMessage = async (userMessage: string) => {
	// ... existing setup ...

	try {
		setIsThinking(true);
		setIsStreaming(true);
		setStreamingContent('');

		// Add user message
		const newUserMessage: Message = {
			role: 'user',
			content: userMessage,
		};
		const updatedMessages = [...messages, newUserMessage];
		setMessages(updatedMessages);

		// Call LLM with streaming callback
		const response = await client.chat(
			updatedMessages,
			toolManager?.getAllTools() || [],
			abortController.signal,
			// Streaming callback - accumulate tokens
			(token: string) => {
				setStreamingContent(prev => prev + token);
			},
		);

		// Streaming complete
		setIsStreaming(false);
		setIsThinking(false);
		setStreamingContent('');

		// Create assistant message with complete content
		const assistantMessage: Message = {
			role: 'assistant',
			content: response.choices[0].message.content || '',
			tool_calls: response.choices[0].message.tool_calls,
		};

		setMessages([...updatedMessages, assistantMessage]);

		// Handle tool calls if present (existing logic)
		// ...
	} catch (error) {
		// Clean up streaming state on error
		setIsStreaming(false);
		setIsThinking(false);
		setStreamingContent('');

		// ... existing error handling ...
	}
};
```

### 3.3 Export Streaming State

**File**: `source/hooks/useChatHandler.tsx`

```typescript
return {
	// ... existing returns ...
	streamingContent,
	isStreaming,
};
```

### Deliverables

- [ ] Streaming state added to `useChatHandler`
- [ ] Message sending logic passes `onToken` callback
- [ ] State cleanup on error/completion
- [ ] TypeScript compilation succeeds

---

## Phase 4: Streaming UI Component (2 hours)

### 4.1 Create StreamingMessage Component

**File**: `source/components/streaming-message.tsx` (NEW)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';
import {parseMarkdown} from '@/utils/markdown-parser';

interface StreamingMessageProps {
	content: string;
	model: string;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = React.memo(
	({content, model}) => {
		const {colors} = useTheme();

		// Blinking cursor effect
		const [showCursor, setShowCursor] = React.useState(true);

		React.useEffect(() => {
			const interval = setInterval(() => {
				setShowCursor(prev => !prev);
			}, 500); // Blink every 500ms

			return () => clearInterval(interval);
		}, []);

		// Parse markdown in real-time (memoized)
		const renderedContent = React.useMemo(() => {
			return parseMarkdown(content, colors);
		}, [content, colors]);

		return (
			<Box flexDirection="column" marginBottom={1}>
				<Box marginBottom={1}>
					<Text color={colors.primary} bold>
						{model}:
					</Text>
				</Box>
				<Box flexDirection="row">
					<Text color={colors.assistant}>{renderedContent}</Text>
					{showCursor && (
						<Text color={colors.primary} bold>
							▊
						</Text>
					)}
				</Box>
			</Box>
		);
	},
);

StreamingMessage.displayName = 'StreamingMessage';
```

### Deliverables

- [ ] `StreamingMessage` component created
- [ ] Cursor blink effect implemented
- [ ] Markdown parsing works during streaming
- [ ] Component is memoized for performance
- [ ] TypeScript compilation succeeds

---

## Phase 5: App Integration (1-2 hours)

### 5.1 Integrate Streaming Component into App

**File**: `source/app.tsx`

**Changes**:

```typescript
import {StreamingMessage} from '@/components/streaming-message';

export default function App() {
	const appState = useAppState(/* ... */);
	const chatHandler = useChatHandler(/* ... */);

	// ... existing logic ...

	return (
		<ThemeContext.Provider value={themeContextValue}>
			<UIStateProvider>
				<Box flexDirection="column" height="100%">
					{/* Status bar, etc. */}

					<Box flexDirection="column" flexGrow={1} overflow="hidden">
						{/* Static messages (historical chat) */}
						<ChatQueue
							staticComponents={staticComponents}
							queuedComponents={appState.chatComponents}
						/>

						{/* Streaming message (live updates, outside Static) */}
						{chatHandler.isStreaming && (
							<StreamingMessage
								content={chatHandler.streamingContent}
								model={appState.currentModel}
							/>
						)}

						{/* Thinking indicator (only when not streaming) */}
						{appState.isThinking && !chatHandler.isStreaming && (
							<ThinkingIndicator />
						)}
					</Box>

					{/* User input */}
					<UserInput
						onSubmit={handleMessageSubmit}
						disabled={appState.isThinking}
					/>
				</Box>
			</UIStateProvider>
		</ThemeContext.Provider>
	);
}
```

**Key Points**:

- `StreamingMessage` is rendered **outside** `ChatQueue`'s `Static` component
- Only shown when `isStreaming` is true
- Once streaming completes, message moves to `ChatQueue` as a static `AssistantMessage`
- `ThinkingIndicator` only shown when thinking but NOT streaming (avoid UI overlap)

### Deliverables

- [ ] `StreamingMessage` integrated into `app.tsx`
- [ ] Conditional rendering based on `isStreaming` state
- [ ] Thinking indicator logic updated
- [ ] TypeScript compilation succeeds
- [ ] Manual testing shows streaming in real-time

---

## Phase 6: Testing (3-4 hours)

### 6.1 Unit Tests for Token Batching

**File**: `source/langgraph-client.spec.ts` (NEW or ADD TO EXISTING)

```typescript
import test from 'ava';
import {LangGraphClient} from './langgraph-client';

test('token batching accumulates tokens before emitting', async t => {
	// Mock implementation
	const config = {
		name: 'test-provider',
		type: 'openai-compatible',
		models: ['test-model'],
		streaming: true,
		config: {
			baseURL: 'http://localhost:8000',
			apiKey: 'test-key',
		},
	};

	const client = new LangGraphClient(config);
	const receivedBatches: string[] = [];

	// Mock the chat call to simulate streaming
	// (Requires mocking LangChain's ChatOpenAI)
	// This is a placeholder - actual implementation will mock LangChain

	t.true(receivedBatches.length > 0);
	t.true(receivedBatches.length < 50); // Should batch, not emit every token
});

test('streaming disabled when config streaming: false', async t => {
	const config = {
		name: 'test-provider',
		type: 'openai-compatible',
		models: ['test-model'],
		streaming: false,
		config: {
			baseURL: 'http://localhost:8000',
			apiKey: 'test-key',
		},
	};

	const client = new LangGraphClient(config);
	const receivedBatches: string[] = [];

	// Mock chat call
	// Verify onToken callback is never called

	t.is(receivedBatches.length, 0);
});
```

### 6.2 Component Tests

**File**: `source/components/__tests__/streaming-message.spec.tsx` (NEW)

```typescript
import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {StreamingMessage} from '../streaming-message';
import {ThemeContext} from '@/hooks/useTheme';

const mockTheme = {
	colors: {
		primary: 'blue',
		assistant: 'green',
		// ... other colors
	},
	name: 'default' as const,
};

test('StreamingMessage renders content and model', t => {
	const {lastFrame} = render(
		<ThemeContext.Provider value={mockTheme}>
			<StreamingMessage content="Hello world" model="GPT-4" />
		</ThemeContext.Provider>,
	);

	const output = lastFrame();
	t.true(output.includes('Hello world'));
	t.true(output.includes('GPT-4'));
});

test('StreamingMessage shows cursor', t => {
	const {lastFrame} = render(
		<ThemeContext.Provider value={mockTheme}>
			<StreamingMessage content="Test" model="Claude" />
		</ThemeContext.Provider>,
	);

	t.true(lastFrame().includes('▊'));
});
```

### 6.3 Integration Testing Checklist

**Manual Tests**:

1. **Basic Streaming**:

   - [ ] Enable streaming for OpenRouter/OpenAI
   - [ ] Send message: "Write a short poem"
   - [ ] Verify tokens appear progressively
   - [ ] Check cursor blinks during streaming
   - [ ] Verify no terminal flickering

2. **Non-Streaming Mode**:

   - [ ] Set `streaming: false` in config
   - [ ] Send message
   - [ ] Verify thinking indicator shows
   - [ ] Verify complete response appears at once (no streaming)

3. **Tool Calls with Streaming**:

   - [ ] Enable streaming
   - [ ] Send message: "Read the README file"
   - [ ] Verify streaming text appears
   - [ ] Verify tool call detected after streaming completes
   - [ ] Verify tool confirmation prompt shows

4. **Cancellation**:

   - [ ] Start streaming response
   - [ ] Press Ctrl+C mid-stream
   - [ ] Verify partial content is displayed
   - [ ] Verify no errors logged
   - [ ] Verify can send new message after cancellation

5. **Long Responses**:

   - [ ] Send message: "Explain quantum computing in detail"
   - [ ] Verify smooth streaming animation
   - [ ] Measure re-renders (should be ~10-15 for 100+ tokens)
   - [ ] Check memory usage remains stable

6. **Provider Switching**:
   - [ ] Switch from streaming→non-streaming provider
   - [ ] Verify behavior changes correctly
   - [ ] Switch back
   - [ ] Verify streaming works again

### Deliverables

- [ ] Unit tests for token batching written
- [ ] Component tests for `StreamingMessage` written
- [ ] All integration tests pass
- [ ] `pnpm test:all` succeeds
- [ ] No regressions in existing functionality

---

## Phase 7: Documentation (1-2 hours)

### 7.1 Update README

**File**: `README.md`

**Add Section**:

````markdown
## Configuration

### Streaming

Nanocoder supports real-time token streaming for LLM responses. Streaming is enabled by default but can be disabled per-provider:

```json
{
	"providers": [
		{
			"name": "OpenRouter",
			"baseUrl": "https://openrouter.ai/api/v1",
			"apiKey": "${OPENROUTER_API_KEY}",
			"models": ["anthropic/claude-sonnet-4"],
			"streaming": true
		},
		{
			"name": "Ollama",
			"baseUrl": "http://localhost:11434/v1",
			"models": ["llama3.1:8b"],
			"streaming": false,
			"requestTimeout": -1
		}
	]
}
```
````

**When to disable streaming**:

- Local models with slow inference (Ollama on CPU)
- Terminal emulators with poor rendering performance
- Preference for complete responses only

````

### 7.2 Update CLAUDE.md

**File**: `CLAUDE.md`

**Add Section**:
```markdown
## Streaming Architecture

Nanocoder implements real-time token streaming with intelligent batching:

- **Token Batching**: Groups tokens into batches of 10 or 75ms intervals
- **Performance**: Reduces re-renders from ~100/response to ~10/response
- **UI Design**: Streaming messages render outside Ink's `Static` component
- **Configuration**: Per-provider `streaming: true/false` in `agents.config.json`

**Key Files**:
- `source/langgraph-client.ts`: Token batching logic
- `source/hooks/useChatHandler.tsx`: Streaming state management
- `source/components/streaming-message.tsx`: Live streaming UI component
- `source/app.tsx`: Integration of streaming component

See `.nanocoder/implementation-notes/streaming-with-token-batching.md` for detailed architecture.
````

### 7.3 Create Configuration Examples

**File**: `agents.config.example.json` (UPDATE)

```json
{
	"providers": [
		{
			"name": "OpenRouter",
			"baseUrl": "https://openrouter.ai/api/v1",
			"apiKey": "${OPENROUTER_API_KEY}",
			"models": ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
			"streaming": true,
			"requestTimeout": 120000
		},
		{
			"name": "OpenAI",
			"baseUrl": "https://api.openai.com/v1",
			"apiKey": "${OPENAI_API_KEY}",
			"models": ["gpt-4o", "gpt-4o-mini"],
			"streaming": true
		},
		{
			"name": "Ollama",
			"baseUrl": "http://localhost:11434/v1",
			"models": ["llama3.1:8b", "qwen2.5-coder:7b"],
			"streaming": false,
			"requestTimeout": -1
		}
	]
}
```

### Deliverables

- [ ] README updated with streaming configuration docs
- [ ] CLAUDE.md updated with architecture overview
- [ ] Example configuration file updated
- [ ] All documentation reviewed for accuracy

---

## Phase 8: Polish and Edge Cases (2-3 hours)

### 8.1 Handle Edge Cases

**8.1.1 Very Short Responses (<10 tokens)**

- Verify time threshold (75ms) flushes tokens even if count threshold not met
- Test with message: "Say hi"

**8.1.2 Network Errors During Streaming**

- Simulate network drop mid-stream
- Verify partial content is preserved
- Verify error message is user-friendly

**8.1.3 Models Without Streaming Support**

- Test with provider that doesn't support streaming
- Verify graceful fallback to non-streaming

**8.1.4 XML Tool Calls During Streaming**

- Test models using XML format (e.g., older Claude models)
- Verify XML not shown during streaming
- Verify clean content after tool calls removed

**8.1.5 Rapid Provider Switching**

- Switch providers multiple times during conversation
- Verify streaming config respected for each provider

### 8.2 Performance Optimization

**8.2.1 Memoization**

- Ensure `StreamingMessage` is memoized
- Ensure `parseMarkdown` is memoized within component
- Profile re-renders with React DevTools

**8.2.2 Memory Leak Check**

- Run long conversation (50+ messages)
- Monitor memory usage
- Verify timers are cleared properly

**8.2.3 Token Buffer Size**

- Verify buffer is flushed regularly (no unbounded growth)
- Check memory usage during streaming

### Deliverables

- [ ] All edge cases tested and handled
- [ ] Performance profiling completed
- [ ] No memory leaks detected
- [ ] Smooth rendering on various terminals (iTerm2, Terminal.app, etc.)

---

## Implementation Timeline

| Phase                           | Duration  | Cumulative  |
| ------------------------------- | --------- | ----------- |
| Phase 1: Type System Updates    | 1-2 hours | 1-2 hours   |
| Phase 2: Streaming Logic        | 3-4 hours | 4-6 hours   |
| Phase 3: Chat Handler State     | 2 hours   | 6-8 hours   |
| Phase 4: Streaming UI Component | 2 hours   | 8-10 hours  |
| Phase 5: App Integration        | 1-2 hours | 9-12 hours  |
| Phase 6: Testing                | 3-4 hours | 12-16 hours |
| Phase 7: Documentation          | 1-2 hours | 13-18 hours |
| Phase 8: Polish & Edge Cases    | 2-3 hours | 15-21 hours |

**Total Estimated Time**: 15-21 hours (2-3 days of focused work)

---

## Rollout Strategy

### Stage 1: Internal Testing (Phases 1-5)

- Implement core functionality
- Basic manual testing
- No external release

### Stage 2: Beta Testing (Phases 6-7)

- Comprehensive testing
- Documentation complete
- Beta release to select users
- Gather feedback on terminal compatibility

### Stage 3: General Release (Phase 8)

- Edge cases handled
- Performance optimized
- Full release with updated docs
- Announce in CHANGELOG.md

---

## Risks and Mitigation

| Risk                              | Impact | Likelihood | Mitigation                                                                |
| --------------------------------- | ------ | ---------- | ------------------------------------------------------------------------- |
| **Terminal flickering**           | High   | Medium     | Use Ink's `Static` for historical messages; keep streaming outside Static |
| **Performance degradation**       | High   | Low        | Token batching reduces re-renders by 90%                                  |
| **LangChain API changes**         | Medium | Low        | Lock LangChain version; test thoroughly                                   |
| **Provider incompatibility**      | Medium | Medium     | Make streaming optional per-provider                                      |
| **Tool call detection broken**    | High   | Low        | XML parser runs after streaming completes (existing logic)                |
| **Cancellation state corruption** | Medium | Low        | Comprehensive cleanup in try/catch/finally blocks                         |

---

## Success Metrics

After implementation, verify:

1. **Performance**: Re-renders reduced from ~100 to ~10-15 per response
2. **Latency**: Tokens displayed within 100ms of generation
3. **Reliability**: All existing tests pass + new streaming tests pass
4. **User Experience**: No terminal flickering; smooth animation
5. **Compatibility**: Works across iTerm2, Terminal.app, and other common terminals
6. **Configuration**: Per-provider streaming toggle works correctly

---

## Rollback Plan

If critical issues arise post-release:

1. **Quick Fix**: Set default `streaming: false` in config loader
2. **Rollback**: Revert commits for Phases 2-5 (keep Phase 1 types for future)
3. **Communication**: Update CHANGELOG with known issues and workaround
4. **Investigation**: Fix root cause before re-enabling

---

## Future Enhancements

After initial implementation is stable, consider:

1. **Adaptive Batching**: Adjust batch interval based on token generation rate
2. **Streaming Progress Bar**: Show % complete for long responses
3. **Partial Tool Call Streaming**: Display tool calls as they're generated
4. **Streaming Content Blocks**: Stream reasoning traces in real-time (for models that support it)
5. **Terminal Capability Detection**: Auto-disable streaming on slow terminals
6. **User-Configurable Batch Size**: Allow customization via config

---

## References

- [LangChain Streaming Docs](https://js.langchain.com/docs/concepts/streaming/)
- [How to stream responses](https://js.langchain.com/docs/how_to/streaming_llm/)
- [ChatOpenAI streaming](https://js.langchain.com/docs/how_to/chat_streaming/)
- [Ink Static component](https://github.com/vadimdemedes/ink#static)
- Implementation research: `.nanocoder/implementation-notes/streaming-architecture-analysis.md`
- Detailed plan: `.nanocoder/implementation-notes/streaming-with-token-batching.md`
