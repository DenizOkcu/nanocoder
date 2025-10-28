# Streaming with Token Batching Implementation Plan

## Overview

Implement real-time token streaming with intelligent batching to minimize React re-renders and Ink terminal flickering. Streaming will be configurable per-provider in `agents.config.json` to allow users to enable/disable based on their terminal capabilities and preferences.

## Motivation

### Benefits of Streaming

1. **Improved perceived responsiveness**: Users see output immediately instead of waiting for complete response
2. **Better for long responses**: Progress visibility for responses that take 10+ seconds
3. **Modern UX**: Matches behavior of ChatGPT, Claude.ai, and other modern AI interfaces
4. **Early cancellation**: Users can cancel mid-stream if response is going wrong direction

### The Flickering Challenge

Nanocoder uses Ink's `Static` component to prevent terminal flickering (see `CHANGELOG.md`):

> "All messages are immediately made static now to further improve performance."

**Problem**: Streaming requires frequent updates (100+ tokens/response) → React re-renders → potential flickering

**Solution**: Token batching + architectural separation

## Current State

**File**: `source/langgraph-client.ts:290-392`

Current `chat()` method waits for complete response:

```typescript
async chat(
  messages: Message[],
  tools: Tool[],
  signal?: AbortSignal,
): Promise<LLMChatResponse> {
  // ... setup ...

  result = (await this.chatModel.invoke(
    langchainMessages,
    invokeOptions,
  )) as AIMessage;

  // Return complete response
  return {
    choices: [{message: convertedMessage}],
  };
}
```

No streaming callback, no progressive updates.

## LangChain v1.0 Streaming API

### Option 1: Callbacks (Recommended)

```typescript
const model = new ChatOpenAI({
	streaming: true,
	callbacks: [
		{
			handleLLMNewToken(token: string) {
				// Called for each token
				onTokenReceived(token);
			},
		},
	],
});
```

### Option 2: .stream() Method

```typescript
const stream = await model.stream(messages);
for await (const chunk of stream) {
	const token = chunk.content;
	onTokenReceived(token);
}
```

We'll use **Option 1 (Callbacks)** as it integrates better with our existing `invoke()` pattern.

## Implementation Plan

### Phase 1: Add Streaming Configuration

**File**: `source/types/config.ts`

Add streaming flag to provider config:

```typescript
export interface LangChainProviderConfig {
	name: string;
	type: string;
	models: string[];
	requestTimeout?: number;
	socketTimeout?: number;
	streaming?: boolean; // New field - default: true
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
	streaming?: boolean; // New field - default: true
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
		streaming?: boolean; // New field - default: true
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

**Example `agents.config.json`**:

```json
{
	"providers": [
		{
			"name": "OpenRouter",
			"baseUrl": "https://openrouter.ai/api/v1",
			"apiKey": "${OPENROUTER_API_KEY}",
			"models": ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
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

### Phase 2: Update LLMClient Interface

**File**: `source/types/core.ts`

Add streaming callback to chat method:

```typescript
export interface LLMClient {
	// Existing methods...
	getCurrentModel(): string;
	getContextSize(): number;
	getAvailableModels(): Promise<string[]>;
	setModel(model: string): void;
	clearContext(): Promise<void>;

	// Updated chat method with optional streaming callback
	chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
		onToken?: (token: string) => void, // New parameter
	): Promise<LLMChatResponse>;
}
```

### Phase 3: Implement Token Batching in LangGraphClient

**File**: `source/langgraph-client.ts`

Add batched streaming support:

```typescript
export class LangGraphClient implements LLMClient {
	private chatModel: ChatOpenAI;
	private currentModel: string;
	private availableModels: string[];
	private providerConfig: LangChainProviderConfig;
	private modelInfoCache: Map<string, ModelInfo> = new Map();
	private undiciAgent: Agent;

	// New: Token batching configuration
	private readonly TOKEN_BATCH_INTERVAL_MS = 75; // ~13 FPS, smooth
	private readonly TOKEN_BATCH_SIZE = 10; // Also batch by count

	constructor(providerConfig: LangChainProviderConfig) {
		// ... existing constructor ...
	}

	async chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
		onToken?: (token: string) => void,
	): Promise<LLMChatResponse> {
		// Check if already aborted
		if (signal?.aborted) {
			throw new Error('Operation was cancelled');
		}

		try {
			const langchainMessages = messages.map(convertToLangChainMessage);
			let result: AIMessage;

			// Token batching state (only used if onToken provided)
			let tokenBuffer = '';
			let tokenCount = 0;
			let lastEmitTime = Date.now();
			let flushTimer: NodeJS.Timeout | null = null;

			const flushTokens = () => {
				if (tokenBuffer && onToken) {
					onToken(tokenBuffer);
					tokenBuffer = '';
					tokenCount = 0;
				}
				if (flushTimer) {
					clearTimeout(flushTimer);
					flushTimer = null;
				}
			};

			// Create streaming callback if onToken provided and streaming enabled
			const streamingEnabled =
				this.providerConfig.streaming !== false && onToken;

			const invokeOptions: any = {signal};

			if (streamingEnabled) {
				invokeOptions.callbacks = [
					{
						handleLLMNewToken: (token: string) => {
							tokenBuffer += token;
							tokenCount++;

							const now = Date.now();
							const timeSinceLastEmit = now - lastEmitTime;

							// Flush if we've hit count threshold OR time threshold
							if (
								tokenCount >= this.TOKEN_BATCH_SIZE ||
								timeSinceLastEmit >= this.TOKEN_BATCH_INTERVAL_MS
							) {
								flushTokens();
								lastEmitTime = now;
							} else if (!flushTimer) {
								// Schedule flush for remaining time
								const remainingTime =
									this.TOKEN_BATCH_INTERVAL_MS - timeSinceLastEmit;
								flushTimer = setTimeout(() => {
									flushTokens();
									lastEmitTime = Date.now();
								}, remainingTime);
							}
						},
					},
				];
			}

			// Try to bind tools if available
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
					// Tool binding failed, fall back to base model
					result = (await this.chatModel.invoke(
						langchainMessages,
						invokeOptions,
					)) as AIMessage;
				}
			} else {
				// No tools, use base model
				result = (await this.chatModel.invoke(
					langchainMessages,
					invokeOptions,
				)) as AIMessage;
			}

			// Flush any remaining tokens
			if (streamingEnabled) {
				flushTokens();
			}

			// Convert result (existing logic)
			let convertedMessage = convertFromLangChainMessage(result);

			// XML tool call parsing fallback (existing logic)
			if (
				tools.length > 0 &&
				(!convertedMessage.tool_calls ||
					convertedMessage.tool_calls.length === 0) &&
				convertedMessage.content
			) {
				const content = convertedMessage.content;

				if (XMLToolCallParser.hasToolCalls(content)) {
					const parsedToolCalls = XMLToolCallParser.parseToolCalls(content);
					const toolCalls =
						XMLToolCallParser.convertToToolCalls(parsedToolCalls);
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
			// Check if this was a cancellation
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error('Operation was cancelled');
			}

			// Parse and throw user-friendly error
			const userMessage = parseAPIError(error);
			throw new Error(userMessage);
		}
	}

	// ... rest of existing methods ...
}
```

### Phase 4: Add Streaming State to Chat Handler

**File**: `source/hooks/useChatHandler.tsx`

Add streaming state and pass callback:

```typescript
export function useChatHandler({
	client,
	toolManager,
}: // ... other params
UseChatHandlerProps) {
	// Existing state...
	const [messages, setMessages] = React.useState<Message[]>([]);
	const [isThinking, setIsThinking] = React.useState(false);

	// New: Streaming state
	const [streamingContent, setStreamingContent] = React.useState('');
	const [isStreaming, setIsStreaming] = React.useState(false);

	const sendMessage = async (userMessage: string) => {
		// ... existing setup ...

		try {
			setIsThinking(true);
			setIsStreaming(true);
			setStreamingContent('');

			// Add user message to messages
			const newUserMessage: Message = {
				role: 'user',
				content: userMessage,
			};
			const updatedMessages = [...messages, newUserMessage];
			setMessages(updatedMessages);

			// Send to LLM with streaming callback
			const response = await client.chat(
				updatedMessages,
				tools,
				abortController.signal,
				// Streaming callback
				(token: string) => {
					setStreamingContent(prev => prev + token);
				},
			);

			// Streaming complete
			setIsStreaming(false);
			setIsThinking(false);
			setStreamingContent('');

			// ... existing response handling ...
			const assistantMessage: Message = {
				role: 'assistant',
				content: response.choices[0].message.content || '',
				tool_calls: response.choices[0].message.tool_calls,
			};

			setMessages([...updatedMessages, assistantMessage]);

			// ... tool confirmation logic ...
		} catch (error) {
			setIsStreaming(false);
			setIsThinking(false);
			setStreamingContent('');
			// ... error handling ...
		}
	};

	return {
		// ... existing returns ...
		streamingContent,
		isStreaming,
		sendMessage,
	};
}
```

### Phase 5: Create Streaming Message Component

**File**: `source/components/streaming-message.tsx` (new)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';

interface StreamingMessageProps {
	content: string;
	model: string;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({
	content,
	model,
}) => {
	const {colors} = useTheme();

	// Blinking cursor effect
	const [showCursor, setShowCursor] = React.useState(true);

	React.useEffect(() => {
		const interval = setInterval(() => {
			setShowCursor(prev => !prev);
		}, 500); // Blink every 500ms

		return () => clearInterval(interval);
	}, []);

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box marginBottom={1}>
				<Text color={colors.primary} bold>
					{model}:
				</Text>
			</Box>
			<Text color={colors.assistant}>
				{content}
				{showCursor && (
					<Text color={colors.primary} bold>
						▊
					</Text>
				)}
			</Text>
		</Box>
	);
};
```

### Phase 6: Integrate Streaming into App Component

**File**: `source/app.tsx`

Display streaming message outside of `Static`:

```typescript
export default function App() {
  const {
    messages,
    streamingContent,
    isStreaming,
    // ... other state
  } = useChatHandler({...});

  // ... existing component rendering ...

  return (
    <Box flexDirection="column" height="100%">
      {/* ... status bar, etc. ... */}

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {/* Static messages (no re-renders) */}
        <ChatQueue
          staticComponents={staticComponents}
          queuedComponents={[]}
        />

        {/* Streaming message (live updates, outside Static) */}
        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            model={currentModel}
          />
        )}

        {/* Thinking indicator (only shown when not streaming) */}
        {isThinking && !isStreaming && <ThinkingIndicator />}
      </Box>

      {/* ... user input ... */}
    </Box>
  );
}
```

### Phase 7: Handle Tool Calls During Streaming

**Challenge**: Tool calls typically come at the end of the response. We need to detect when streaming transitions from content to tool calls.

**Solution**: Buffer and detect XML tool calls after streaming completes:

```typescript
// In useChatHandler.tsx sendMessage()
const response = await client.chat(
	updatedMessages,
	tools,
	abortController.signal,
	(token: string) => {
		// Accumulate tokens
		setStreamingContent(prev => prev + token);
	},
);

// After streaming completes, check for tool calls
const finalContent = response.choices[0].message.content || '';
const toolCalls = response.choices[0].message.tool_calls;

// If XML tool calls detected, they're already parsed by LangGraphClient
// Display final content (may have tool calls removed)
```

**No special handling needed** - the existing XML parser in `LangGraphClient` handles this after streaming completes.

## Token Batching Algorithm

### Dual-Threshold Approach

Flush tokens when EITHER condition is met:

1. **Count threshold**: 10 tokens accumulated
2. **Time threshold**: 75ms elapsed since last flush

### Why This Works

- **Fast responses**: Flush every 10 tokens (feels instant)
- **Slow responses**: Flush every 75ms even if <10 tokens (no stalling)
- **Result**: ~13 FPS update rate (smooth animation)

### Performance Impact

**Before batching** (naive streaming):

- 100 tokens/response × 1 re-render/token = **100 re-renders**
- Ink flickers, terminal struggles

**After batching**:

- 100 tokens/response ÷ 10 tokens/batch = **10 re-renders**
- Smooth, no flicker, `Static` messages remain stable

## Configuration Examples

### Example 1: Enable Streaming for OpenRouter (Fast API)

```json
{
	"providers": [
		{
			"name": "OpenRouter",
			"baseUrl": "https://openrouter.ai/api/v1",
			"apiKey": "${OPENROUTER_API_KEY}",
			"models": ["anthropic/claude-sonnet-4"],
			"streaming": true
		}
	]
}
```

### Example 2: Disable Streaming for Ollama (Local, May Be Slow)

```json
{
	"providers": [
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

### Example 3: Mixed Configuration

```json
{
	"providers": [
		{
			"name": "OpenRouter",
			"baseUrl": "https://openrouter.ai/api/v1",
			"apiKey": "${OPENROUTER_API_KEY}",
			"models": ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
			"streaming": true
		},
		{
			"name": "Ollama",
			"baseUrl": "http://localhost:11434/v1",
			"models": ["qwen2.5-coder:7b"],
			"streaming": false
		},
		{
			"name": "OpenAI",
			"baseUrl": "https://api.openai.com/v1",
			"apiKey": "${OPENAI_API_KEY}",
			"models": ["gpt-4o"],
			"streaming": true
		}
	]
}
```

## Testing Strategy

### Unit Tests

**File**: `source/langgraph-client.spec.ts`

```typescript
import test from 'ava';
import {LangGraphClient} from './langgraph-client';

test('streaming callback receives batched tokens', async t => {
	const config = {
		name: 'test',
		type: 'openai-compatible',
		models: ['test-model'],
		streaming: true,
		config: {baseURL: 'http://test', apiKey: 'test'},
	};

	const client = new LangGraphClient(config);
	const tokens: string[] = [];

	await client.chat(
		[{role: 'user', content: 'Hello'}],
		[],
		undefined,
		token => {
			tokens.push(token);
		},
	);

	// Should receive batched tokens, not individual
	t.true(tokens.length > 0);
	t.true(tokens.length < 100); // Batched, not 100+ individual tokens
});

test('streaming disabled when streaming:false in config', async t => {
	const config = {
		name: 'test',
		type: 'openai-compatible',
		models: ['test-model'],
		streaming: false,
		config: {baseURL: 'http://test', apiKey: 'test'},
	};

	const client = new LangGraphClient(config);
	const tokens: string[] = [];

	await client.chat(
		[{role: 'user', content: 'Hello'}],
		[],
		undefined,
		token => {
			tokens.push(token);
		},
	);

	// Should not receive any tokens (streaming disabled)
	t.is(tokens.length, 0);
});
```

**File**: `source/components/__tests__/streaming-message.spec.tsx`

```typescript
import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {StreamingMessage} from '../streaming-message';

test('StreamingMessage renders content', t => {
	const {lastFrame} = render(
		<StreamingMessage content="Hello world" model="GPT-4" />,
	);

	t.true(lastFrame().includes('Hello world'));
	t.true(lastFrame().includes('GPT-4'));
});

test('StreamingMessage shows cursor', t => {
	const {lastFrame} = render(
		<StreamingMessage content="Test" model="Claude" />,
	);

	// Should show cursor character
	t.true(lastFrame().includes('▊'));
});
```

### Integration Tests

**Manual testing checklist**:

1. **Test with fast API (OpenRouter/OpenAI)**:

   - Enable streaming in config
   - Send message, verify tokens appear progressively
   - Check for smooth updates (no flicker)
   - Verify cursor blinks during streaming

2. **Test with slow API (Ollama)**:

   - Test both `streaming: true` and `streaming: false`
   - Verify batching works even with slow token generation
   - Check timeout handling

3. **Test tool calls with streaming**:

   - Ask for file reads, bash commands
   - Verify tool calls detected after streaming completes
   - Check XML parsing works correctly

4. **Test cancellation during streaming**:

   - Start streaming response
   - Press Ctrl+C mid-stream
   - Verify clean cancellation, no errors
   - Check partial content is not lost

5. **Test with different providers**:
   - OpenRouter (streaming enabled)
   - Ollama (streaming disabled)
   - Switch between providers
   - Verify config is respected per-provider

## Edge Cases

### 1. Very Fast Responses (<10 tokens)

If response is shorter than batch size:

- Time threshold (75ms) ensures tokens are flushed
- May get 1-2 batches total
- Still better UX than waiting for complete response

### 2. Network Issues During Streaming

If connection drops mid-stream:

- AbortController cancels request
- Partial content is displayed
- Error message shown
- User can retry

### 3. Models Without Streaming Support

Some models/providers may not support streaming:

- LangChain will fall back to non-streaming
- Callback never called
- Works like current implementation (wait for complete response)

### 4. XML Tool Calls During Streaming

Models using XML format for tool calls:

- Streaming shows partial XML tags (bad UX)
- **Solution**: Don't show XML during streaming
- Parse and display clean content after streaming completes
- Already handled by `XMLToolCallParser.removeToolCallsFromContent()`

### 5. Switching Providers Mid-Conversation

User switches from streaming→non-streaming or vice versa:

- Config is read per-request
- Works seamlessly
- No state conflicts

## Performance Considerations

### React Re-Renders

**Optimization 1**: Memoize StreamingMessage component

```typescript
export const StreamingMessage = React.memo(({content, model}) => {
	// ... component logic
});
```

**Optimization 2**: Debounce state updates

Already handled by token batching (updates every 75ms max).

**Optimization 3**: Keep streaming outside Static

Streaming message is NOT in `Static` (by design):

- Static messages never re-render
- Only streaming message re-renders (~13 times/response)
- Once streaming completes, message moves to Static

### Memory Usage

Token buffer is flushed every 10 tokens:

- Max buffer size: ~10 tokens × ~4 chars/token = **40 bytes**
- Negligible memory impact

## Migration Path

### Phase 1: Implement Core (Week 1)

1. Add streaming config to types
2. Implement token batching in LangGraphClient
3. Add streaming state to useChatHandler

### Phase 2: UI Components (Week 1)

4. Create StreamingMessage component
5. Integrate into app.tsx
6. Test with OpenRouter/OpenAI

### Phase 3: Testing & Polish (Week 2)

7. Manual testing across providers
8. Unit tests for batching logic
9. Handle edge cases
10. Performance optimization

### Phase 4: Documentation (Week 2)

11. Update README with streaming configuration
12. Add examples to agents.config.json
13. Document performance characteristics

**Total estimated effort**: 12-16 hours over 2 weeks

## Success Criteria

- [ ] Streaming works with LangChain v1.0 models
- [ ] Token batching reduces re-renders to ~10-15 per response
- [ ] No terminal flickering (Static messages remain stable)
- [ ] Per-provider streaming configuration works
- [ ] Cancellation works cleanly mid-stream
- [ ] Tool calls detected correctly after streaming
- [ ] Tests pass for streaming and non-streaming modes
- [ ] Performance is smooth on different terminal emulators

## Future Enhancements

1. **Adaptive Batching**: Adjust batch interval based on token rate
2. **Streaming Progress Bar**: Show % complete for long responses
3. **Partial Tool Call Streaming**: Show tool calls as they're generated
4. **Streaming Content Blocks**: Stream reasoning traces in real-time
5. **Terminal-Specific Optimization**: Detect terminal capabilities and adjust batching

## References

- [LangChain Streaming Docs](https://js.langchain.com/docs/concepts/streaming/)
- [How to stream responses](https://js.langchain.com/docs/how_to/streaming_llm/)
- [ChatOpenAI streaming](https://js.langchain.com/docs/how_to/chat_streaming/)
- [Ink Static component](https://github.com/vadimdemedes/ink#static)
