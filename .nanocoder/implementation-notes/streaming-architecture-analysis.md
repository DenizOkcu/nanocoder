# Nanocoder Streaming Implementation Analysis

## Executive Summary

Nanocoder **currently does NOT implement token streaming**. The application uses a **non-streaming, wait-for-complete-response** architecture. All LLM responses are fetched completely before being displayed to the user, with only a thinking/spinner indicator shown during processing.

This document provides a detailed analysis of the current streaming architecture and outlines how token batching can be implemented for a responsive, flicker-free user experience.

---

## 1. Current Streaming Flow (Non-Streaming)

### 1.1 LLM Client Implementation

**File**: `/source/langgraph-client.ts` (lines 290-392)

The `LangGraphClient.chat()` method uses **synchronous `invoke()` calls** from LangChain:

```typescript
async chat(
  messages: Message[],
  tools: Tool[],
  signal?: AbortSignal,
): Promise<LLMChatResponse> {
  // ... setup ...

  result = (await modelWithTools.invoke(
    langchainMessages,
    invokeOptions,  // Only contains { signal }
  )) as AIMessage;

  // Returns complete response all at once
  return {
    choices: [{
      message: convertedMessage
    }]
  };
}
```

**Key observations**:

- Uses `.invoke()` instead of `.stream()`
- No streaming callbacks configured
- No `onToken` parameter exists
- Response waits for complete LLM generation

---

### 1.2 Message Handler

**File**: `/source/message-handler.ts`

The message handler is **tool-focused** and does NOT handle streaming:

```typescript
export async function processToolUse(toolCall: ToolCall): Promise<ToolResult> {
	// Tool execution logic only
	// No streaming support
}
```

---

### 1.3 Chat Handler Hook

**File**: `/source/hooks/useChatHandler.tsx` (lines 76-580)

The `useChatHandler` hook orchestrates the conversation:

```typescript
const result = await client.chat(
	[systemMessage, ...messages],
	toolManager?.getAllTools() || [],
	controller.signal,
	// NO streaming callback parameter
);
```

**Process flow**:

1. User types message
2. `handleChatMessage()` called (line 500)
3. `setIsThinking(true)` (line 532)
4. **Waits for complete response** from LLM
5. Displays `AssistantMessage` component (line 202)
6. Processes tool calls if present
7. `setIsThinking(false)` (line 493)

---

### 1.4 UI Rendering

**File**: `/source/components/chat-queue.tsx`

```typescript
export default memo(function ChatQueue({
	staticComponents = [],
	queuedComponents = [],
}: ChatQueueProps) {
	// Move ALL messages to static - prevents any re-renders
	const allStaticComponents = useMemo(
		() => [...staticComponents, ...queuedComponents],
		[staticComponents, queuedComponents],
	);

	return (
		<Box flexDirection="column">
			{allStaticComponents.length > 0 && (
				<Static items={allStaticComponents}>
					{/* Renders complete messages only */}
				</Static>
			)}
		</Box>
	);
});
```

**Key design choice**: Uses Ink's `Static` component to prevent terminal flickering:

- All messages are immediately made static after rendering
- Designed for no re-renders during long conversations
- This is the **constraint** that makes streaming challenging

---

## 2. Message Handling & State Management

### 2.1 App State

**File**: `/source/hooks/useAppState.tsx` (lines 19-228)

Central state management:

```typescript
const [messages, setMessages] = useState<Message[]>([]);
const [displayMessages, setDisplayMessages] = useState<Message[]>([]);
const [chatComponents, setChatComponents] = useState<React.ReactNode[]>([]);
const [componentKeyCounter, setComponentKeyCounter] = useState(0);

const addToChatQueue = useCallback(
	(component: React.ReactNode) => {
		setChatComponents(prevComponents => {
			const newComponents = [...prevComponents, componentWithKey];
			// Keep reasonable limit in memory for performance
			return newComponents.length > 50
				? newComponents.slice(-50)
				: newComponents;
		});
	},
	[componentKeyCounter],
);
```

**State flow**:

1. `messages` - full conversation history (preserved for LLM context)
2. `displayMessages` - limited to last 30 for UI performance
3. `chatComponents` - React components queued for rendering
4. `componentKeyCounter` - ensures stable key generation

**Note**: No streaming state exists currently

---

### 2.2 Message Display

**File**: `/source/components/assistant-message.tsx`

```typescript
export default memo(function AssistantMessage({
	message,
	model,
}: AssistantMessageProps) {
	const {colors} = useTheme();

	// Render markdown to terminal-formatted text
	const renderedMessage = useMemo(() => {
		return parseMarkdown(message, colors);
	}, [message, colors]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color={colors.primary} bold>
				{model}:
			</Text>
			<Text>{renderedMessage}</Text>
		</Box>
	);
});
```

**Process**:

- Component is memoized (prevents unnecessary re-renders)
- Receives complete `message` string
- Parses markdown once via `useMemo`
- Rendered immediately to static

---

## 3. Current UI Re-render Pattern

### 3.1 Component Lifecycle

**File**: `/source/app.tsx`

```typescript
return (
	<ThemeContext.Provider value={themeContextValue}>
		<UIStateProvider>
			<Box flexDirection="column" padding={1} width="100%">
				{/* Flexible layout */}
				<Box flexGrow={1} flexDirection="column" minHeight={0}>
					{appState.startChat && (
						<ChatQueue
							staticComponents={staticComponents}
							queuedComponents={appState.chatComponents}
						/>
					)}
				</Box>

				{/* Status indicators */}
				{appState.isThinking && <ThinkingIndicator />}

				{/* User input */}
				<UserInput
					onSubmit={handleMessageSubmit}
					disabled={appState.isThinking}
				/>
			</Box>
		</UIStateProvider>
	</ThemeContext.Provider>
);
```

**Re-render triggers**:

- `appState.chatComponents` changes → ChatQueue re-renders
- `appState.isThinking` changes → ThinkingIndicator shown/hidden
- Responses added to queue via `addToChatQueue()`

---

## 4. Token Processing Architecture

### 4.1 Where Tokens Are Received

**Current**: Tokens are NOT received incrementally. LangChain's `.invoke()` returns complete response.

```typescript
// LangChain internally streams tokens but doesn't expose them
result = (await modelWithTools.invoke(
	langchainMessages,
	invokeOptions, // No streaming config
)) as AIMessage;

// Result contains full text immediately
const fullContent = result.content;
```

### 4.2 Data Structures for Streaming State

**Currently**: No streaming state exists

**Proposed** (from implementation notes):

```typescript
// Temporary state during streaming
interface StreamingState {
	tokenBuffer: string; // Accumulates tokens
	tokenCount: number; // Tokens since last batch
	lastEmitTime: Date; // Track batching interval
	flushTimer?: NodeJS.Timeout; // Schedule flush
}
```

---

## 5. Performance Considerations

### 5.1 Current Bottlenecks

1. **Long wait times**: Users see only spinner while waiting for complete response
2. **Perceived slowness**: Large responses (1000+ tokens) feel slow
3. **No early feedback**: Can't tell if model is stuck vs. generating long response
4. **Memory**: Entire response accumulated before display

### 5.2 Existing Optimizations

**In `useAppState.tsx`**:

```typescript
// Token calculation with caching
const getMessageTokens = useCallback(
	(message: Message) => {
		const cacheKey = (message.content || '') + message.role;
		const cachedTokens = messageTokenCache.get(cacheKey);
		if (cachedTokens !== undefined) {
			return cachedTokens;
		}
		const tokens = Math.ceil((message.content?.length || 0) / 4);
		return tokens;
	},
	[messageTokenCache],
);

// Display limit for UI performance
const updateMessages = useCallback((newMessages: Message[]) => {
	setMessages(newMessages); // Full context for LLM

	// Limit display for UI
	const displayLimit = 30;
	setDisplayMessages(
		newMessages.length > displayLimit
			? newMessages.slice(-displayLimit)
			: newMessages,
	);
}, []);
```

---

## 6. Architecture Diagram

### Current Flow (Non-Streaming)

```
┌─────────────┐
│ User Input  │
└──────┬──────┘
       │
       ▼
┌──────────────────────┐
│ useChatHandler       │
│ handleChatMessage()  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ LangGraphClient.chat()               │
│ await chatModel.invoke()  ◄──────┐   │
│ [WAIT FOR COMPLETE RESPONSE]     │   │
│                                  │   │
│ • Process response              │   │
│ • Parse tool calls              │   │
│ • XML parsing fallback          │   │
│                                 │   │
│ LangChain (internal streaming)  │   │
│ (tokens not exposed)────────────┘   │
└──────┬───────────────────────────────┘
       │ (complete response)
       ▼
┌─────────────────────────────┐
│ addToChatQueue()            │
│ AssistantMessage component  │
└──────┬──────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ App State Update             │
│ setChatComponents([...])     │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ ChatQueue (Static)           │
│ [React Ink Re-render]        │
│ (Entire component static)    │
└──────────────────────────────┘
```

---

## 7. Potential Pain Points & Bottlenecks

### 7.1 Streaming Design Challenges

| Challenge                       | Severity | Impact                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------- |
| **Static Component Constraint** | High     | Can't update messages in-place; must create new component     |
| **Terminal Flickering**         | High     | Naive streaming causes visible terminal flicker with `Static` |
| **React Re-renders**            | Medium   | 100+ tokens × 1 render/token = 100 re-renders                 |
| **Tool Call Detection**         | Medium   | Must buffer entire response to find XML tool calls            |
| **Cancellation State**          | Medium   | Partial content should be preserved if cancelled              |
| **Memory Usage**                | Low      | Token buffer is small (~40 bytes)                             |

### 7.2 Current Implementation Gaps

1. **No streaming callback in LLMClient interface**
2. **No streaming state in chat handler**
3. **No streaming UI component**
4. **No token batching logic**
5. **UI designed for complete responses only**

---

## 8. Where Token Batching Fits

### 8.1 Proposed Architecture

```
┌──────────────────────────────────────────┐
│ LangGraphClient.chat()                   │
│ (NEW: with onToken callback)             │
└──────┬───────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│ LangChain ChatOpenAI.invoke()             │
│ callbacks: [handleLLMNewToken]           │
│                                          │
│ Token Flow:                              │
│ ┌────────────────────────────────────┐   │
│ │ Token #1, #2, #3 ...              │   │
│ │ (individual tokens from LLM stream)│   │
│ └────────────┬───────────────────────┘   │
│              ▼                            │
│ ┌──────────────────────────────┐         │
│ │ Token Batching Logic         │         │
│ │ Buffer: ''                   │         │
│ │ Count: 0                     │         │
│ │ LastEmit: Date.now()         │         │
│ │                              │         │
│ │ Rules:                       │         │
│ │ • Flush if 10 tokens OR      │         │
│ │ • Flush if 75ms elapsed      │         │
│ └────────────┬─────────────────┘         │
│              ▼                            │
│ Batch: "Hello world..." (10 tokens)      │
│ Call: onToken("Hello world...")          │
└──────┬───────────────────────────────────┘
       │ (batched tokens, ~10 per batch)
       ▼
┌──────────────────────────────────────────┐
│ useChatHandler.tsx                       │
│ setStreamingContent(prev => prev + batch)│
└──────┬───────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│ App State: streamingContent              │
│ isStreaming: true                        │
└──────┬───────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│ StreamingMessage Component (NEW)         │
│ (Outside Static - live re-renders)       │
│                                          │
│ Shows:                                   │
│ • Accumulated content in real-time       │
│ • Blinking cursor (▊) while streaming    │
│ • Formatted markdown                     │
└──────────────────────────────────────────┘

When streaming completes:
       ▼
┌──────────────────────────────────────────┐
│ Move to AssistantMessage                 │
│ Add to Static (via ChatQueue)            │
│ Final component never re-renders         │
└──────────────────────────────────────────┘
```

### 8.2 Token Batching Algorithm

**Dual-Threshold Approach**:

```typescript
private readonly TOKEN_BATCH_INTERVAL_MS = 75;  // ~13 FPS
private readonly TOKEN_BATCH_SIZE = 10;

handleLLMNewToken(token: string) {
  tokenBuffer += token;
  tokenCount++;

  const now = Date.now();
  const timeSinceLastEmit = now - lastEmitTime;

  // Flush if EITHER condition met:
  if (
    tokenCount >= TOKEN_BATCH_SIZE ||      // Count threshold
    timeSinceLastEmit >= TOKEN_BATCH_INTERVAL_MS  // Time threshold
  ) {
    if (tokenBuffer && onToken) {
      onToken(tokenBuffer);
      tokenBuffer = '';
      tokenCount = 0;
    }
    lastEmitTime = now;
  } else if (!flushTimer) {
    // Schedule flush for remaining time
    const remainingTime = TOKEN_BATCH_INTERVAL_MS - timeSinceLastEmit;
    flushTimer = setTimeout(() => {
      if (tokenBuffer && onToken) {
        onToken(tokenBuffer);
        tokenBuffer = '';
      }
      lastEmitTime = Date.now();
    }, remainingTime);
  }
}
```

**Performance Impact**:

- **Before**: 100 tokens/response × 1 re-render/token = **100 re-renders**
- **After**: 100 tokens/response ÷ 10 tokens/batch = **10 re-renders**
- **Result**: ~13 FPS, smooth animation, no flickering

---

## 9. Key Files & Line Numbers

### Current Implementation

| File                                      | Lines   | Purpose                              |
| ----------------------------------------- | ------- | ------------------------------------ |
| `source/langgraph-client.ts`              | 290-392 | LLM client (non-streaming `chat()`)  |
| `source/hooks/useChatHandler.tsx`         | 76-580  | Chat handler (calls `client.chat()`) |
| `source/hooks/useAppState.tsx`            | 19-228  | Central state management             |
| `source/components/chat-queue.tsx`        | 1-37    | Static message rendering             |
| `source/components/assistant-message.tsx` | 1-109   | Assistant message display            |
| `source/types/core.ts`                    | 1-100   | LLMClient interface (no streaming)   |

### Streaming References (Documentation Only)

| File                                                               | Purpose                             |
| ------------------------------------------------------------------ | ----------------------------------- |
| `.nanocoder/implementation-notes/streaming-support.md`             | Initial streaming design            |
| `.nanocoder/implementation-notes/streaming-with-token-batching.md` | **Recommended** token batching plan |
| `.nanocoder/implementation-notes/langgraph-migration.md`           | Future LangGraph migration          |

---

## 10. Implementation Roadmap

### Phase 1: Core Streaming (2-3 hours)

**Files to modify**:

1. `source/types/core.ts` - Add `onToken` callback to `LLMClient.chat()`
2. `source/langgraph-client.ts` - Implement token batching in `chat()` method
3. `source/hooks/useChatHandler.tsx` - Add streaming state and callback

### Phase 2: UI Components (2 hours)

4. `source/components/streaming-message.tsx` (**NEW**) - Display streaming content
5. `source/app.tsx` - Integrate streaming message outside `Static`

### Phase 3: Configuration (1 hour)

6. `source/types/config.ts` - Add `streaming` boolean to provider config
7. `agents.config.json` - Configuration examples

### Phase 4: Testing & Edge Cases (3-4 hours)

8. Unit tests for token batching
9. Integration tests for streaming + tool calls
10. Manual testing across providers

**Total**: 10-13 hours

---

## 11. Success Criteria

- [x] Understand current architecture
- [ ] Tokens display in real-time (<100ms latency)
- [ ] Token batching reduces re-renders to 10-15 per response
- [ ] No terminal flickering (Static messages remain stable)
- [ ] Per-provider streaming configuration works
- [ ] Cancellation works cleanly mid-stream
- [ ] Tool calls detected correctly after streaming
- [ ] All existing tests pass

---

## Appendix: LangChain v1.0 Streaming APIs

### Option 1: Callbacks (Recommended)

```typescript
const callbacks = [
	{
		handleLLMNewToken(token: string) {
			onToken(token);
		},
	},
];

result = await chatModel.invoke(messages, {callbacks});
```

**Pros**: Simple, integrates with existing `.invoke()` pattern
**Cons**: Tokens available only during invocation

### Option 2: .stream() Method

```typescript
const stream = await chatModel.stream(messages);
for await (const chunk of stream) {
	const token = chunk.content;
	onToken(token);
}
```

**Pros**: More flexible, explicit streaming
**Cons**: Requires refactoring from `.invoke()` to `.stream()`

### Option 3: streamEvents()

```typescript
const stream = await model.streamEvents(messages, {version: 'v1'});
for await (const event of stream) {
	if (event.event === 'on_chat_model_stream') {
		const token = event.data?.chunk?.content;
	}
}
```

**Pros**: More events available
**Cons**: More complex, events structure

---

## References

- [LangChain Streaming Docs](https://js.langchain.com/docs/concepts/streaming/)
- [ChatOpenAI Streaming](https://js.langchain.com/docs/how_to/chat_streaming/)
- [Ink Static Component](https://github.com/vadimdemedes/ink#static)
- Implementation notes in `.nanocoder/implementation-notes/`
