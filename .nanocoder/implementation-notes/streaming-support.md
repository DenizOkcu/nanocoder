# Streaming Support Implementation Note

## Overview

Add real-time token streaming to Nanocoder using LangChain's streaming capabilities. This will display LLM responses token-by-token as they're generated, improving perceived responsiveness and user experience.

## Current State

- LLM responses are fetched completely before displaying to user
- Users wait for entire response with only a spinner/thinking indicator
- Located in: `source/langgraph-client.ts:280-382` (`chat()` method)

## LangChain Streaming APIs

### Option 1: Callbacks (Simpler)

```typescript
const model = new ChatOpenAI({
	streaming: true,
	callbacks: [
		{
			handleLLMNewToken(token: string) {
				// Emit token for display
			},
		},
	],
});
```

### Option 2: streamEvents() (More Flexible)

```typescript
const stream = await model.streamEvents(messages, {version: 'v1'});
for await (const event of stream) {
	if (event.event === 'on_chat_model_stream') {
		const token = event.data?.chunk?.content;
		// Process token
	}
}
```

## Implementation Plan

### 1. Update LangGraphClient Interface

**File**: `source/types/core.ts`

Add streaming method to `LLMClient` interface:

```typescript
export interface LLMClient {
	// Existing methods...
	chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
	): Promise<LLMChatResponse>;

	// New streaming method
	streamChat(
		messages: Message[],
		tools: Tool[],
		onToken: (token: string) => void,
		signal?: AbortSignal,
	): Promise<LLMChatResponse>;
}
```

### 2. Implement Streaming in LangGraphClient

**File**: `source/langgraph-client.ts`

Add new method:

```typescript
async streamChat(
  messages: Message[],
  tools: Tool[],
  onToken: (token: string) => void,
  signal?: AbortSignal
): Promise<LLMChatResponse> {
  const langchainMessages = messages.map(convertToLangChainMessage);
  let fullContent = '';
  let result: AIMessage;

  try {
    // Enable streaming on the model
    const streamingConfig = {
      callbacks: [{
        handleLLMNewToken(token: string) {
          fullContent += token;
          onToken(token);
        }
      }]
    };

    if (tools.length > 0) {
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

      result = await modelWithTools.invoke(
        langchainMessages,
        { signal, ...streamingConfig }
      ) as AIMessage;
    } else {
      result = await this.chatModel.invoke(
        langchainMessages,
        { signal, ...streamingConfig }
      ) as AIMessage;
    }

    // Convert result (same as existing chat() method)
    let convertedMessage = convertFromLangChainMessage(result);

    // XML tool call parsing fallback
    if (tools.length > 0 && (!convertedMessage.tool_calls || convertedMessage.tool_calls.length === 0)) {
      // ... existing XML parsing logic
    }

    return {
      choices: [{
        message: {
          role: 'assistant' as const,
          content: convertedMessage.content,
          tool_calls: convertedMessage.tool_calls,
        },
      }],
    };
  } catch (error) {
    // ... existing error handling
  }
}
```

### 3. Add Streaming UI Component

**File**: `source/components/streaming-message.tsx` (new file)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/contexts/theme-context';

interface StreamingMessageProps {
	content: string;
	isComplete: boolean;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({
	content,
	isComplete,
}) => {
	const {theme} = useTheme();

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color={theme.assistant}>
				{content}
				{!isComplete && <Text color={theme.dim}>▊</Text>}
			</Text>
		</Box>
	);
};
```

### 4. Update Chat Handler Hook

**File**: `source/hooks/useChatHandler.tsx`

Add streaming state and modify `sendMessage()`:

```typescript
export function useChatHandler(
	{
		/* ... */
	},
) {
	const [streamingContent, setStreamingContent] = React.useState<string>('');
	const [isStreaming, setIsStreaming] = React.useState(false);

	const sendMessage = async (userMessage: string) => {
		// ... existing setup ...

		try {
			setIsStreaming(true);
			setStreamingContent('');

			const response = await client.streamChat(
				updatedMessages,
				tools,
				(token: string) => {
					// Update streaming content as tokens arrive
					setStreamingContent(prev => prev + token);
				},
				abortController.signal,
			);

			setIsStreaming(false);

			// ... existing response handling ...
		} catch (error) {
			setIsStreaming(false);
			// ... error handling ...
		}
	};

	return {
		// ... existing returns
		streamingContent,
		isStreaming,
	};
}
```

### 5. Update Main App Component

**File**: `source/app.tsx`

Display streaming message in chat queue:

```typescript
{
	isStreaming && (
		<StreamingMessage content={streamingContent} isComplete={false} />
	);
}
```

## Edge Cases & Considerations

### 1. Tool Calls with Streaming

- Tool calls typically come at the end of the response
- May need to detect when streaming transitions from content to tool calls
- Consider: buffer tokens until we know if there are tool calls?

### 2. XML Tool Call Format

- Models without native tool calling use XML format
- Streaming may show partial XML tags (bad UX)
- **Solution**: Buffer content, parse XML, only display clean text portions

### 3. Cancellation During Streaming

- AbortController should work with streaming
- Clean up streaming state on cancellation
- Ensure partial content is not lost

### 4. Error Handling

- Stream may fail mid-response
- Display partial content + error message
- Allow retry from last complete message

### 5. Performance

- React re-renders on every token (could be 100+ per response)
- Consider: batch token updates (e.g., every 50ms) to reduce renders
- Use `React.memo()` or `useMemo()` for streaming component

## Testing Strategy

1. **Unit Tests**: Mock streaming callbacks, verify token accumulation
2. **Integration Tests**: Test with actual model, verify complete responses
3. **Manual Tests**:
   - Long responses (>1000 tokens)
   - Responses with tool calls
   - Cancellation mid-stream
   - Network errors during streaming
   - XML tool call format with streaming

## Configuration

Add user preference for streaming:

```json
// nanocoder-preferences.json
{
	"enableStreaming": true // default: true
}
```

Allow disabling for debugging or compatibility issues.

## Performance Optimization

### Token Batching

```typescript
let tokenBuffer = '';
let lastEmit = Date.now();
const EMIT_INTERVAL_MS = 50;

handleLLMNewToken(token: string) {
  tokenBuffer += token;
  const now = Date.now();

  if (now - lastEmit >= EMIT_INTERVAL_MS) {
    onToken(tokenBuffer);
    tokenBuffer = '';
    lastEmit = now;
  }
}
```

## Migration Path

1. Implement `streamChat()` alongside existing `chat()` method
2. Add feature flag to switch between streaming/non-streaming
3. Test thoroughly with different models and scenarios
4. Default to streaming after validation period
5. Eventually deprecate non-streaming `chat()` method

## Alternative: Stream with .stream() Method

LangChain also provides `.stream()` which returns an async iterator:

```typescript
const stream = await model.stream(messages);
for await (const chunk of stream) {
	const token = chunk.content;
	onToken(token);
}
```

This is cleaner but may have different error handling characteristics.

## References

- [LangChain Streaming Docs](https://js.langchain.com/docs/concepts/streaming/)
- [How to stream responses](https://js.langchain.com/docs/how_to/streaming_llm/)
- [ChatOpenAI streaming](https://js.langchain.com/docs/how_to/chat_streaming/)

## Estimated Effort

- Implementation: 4-6 hours
- Testing: 2-3 hours
- Edge case handling: 2-3 hours
- **Total: 8-12 hours**

## Success Criteria

- [ ] Tokens display in real-time with <100ms latency
- [ ] Tool calls work correctly with streaming
- [ ] Cancellation works mid-stream
- [ ] No performance degradation (UI remains responsive)
- [ ] Error handling maintains conversation state
- [ ] Works with all supported models (OpenAI, OpenRouter, local)
