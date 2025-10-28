# Content Blocks Support Implementation Plan

## Overview

Add support for LangChain v1.0's Standard Content Blocks to display provider-agnostic reasoning traces, citations, and other advanced LLM features across all supported models (Claude, OpenAI o1, Gemini, etc.).

## Motivation

LangChain v1.0 introduced standardized content blocks that provide unified access to:

- **Reasoning traces**: Claude's `<thinking>`, OpenAI o1's reasoning, DeepSeek's chain-of-thought
- **Citations**: Source references from models that support them
- **Built-in tools**: Web search results, code interpreter outputs
- **Multimodal content**: Images, audio (future support)

This allows Nanocoder to display these features consistently regardless of provider, improving transparency and user experience.

## Current State

**File**: `source/components/assistant-message.tsx:82-108`

Currently only displays text content:

```typescript
export default memo(function AssistantMessage({message, model}) {
	const renderedMessage = useMemo(() => {
		return parseMarkdown(message, colors);
	}, [message, colors]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text>{renderedMessage}</Text>
		</Box>
	);
});
```

Messages are converted from LangChain's `AIMessage` but content blocks are not extracted:

```typescript
// source/langgraph-client.ts:126-143
function convertFromLangChainMessage(message: AIMessage): Message {
	const result: Message = {
		role: 'assistant',
		content: message.content as string, // Only text content
	};
	// ... tool_calls handling
	return result;
}
```

## LangChain v1.0 Content Blocks API

### Available Block Types

```typescript
import {ContentBlock} from '@langchain/core/messages';

// Text content
type TextBlock = {
	type: 'text';
	text: string;
};

// Reasoning/thinking
type ReasoningBlock = {
	type: 'reasoning';
	reasoning: string;
};

// Citations
type CitationBlock = {
	type: 'citation';
	citation: {
		source: string;
		title?: string;
		url?: string;
	};
};

// Tool results
type ToolResultBlock = {
	type: 'tool_result';
	tool_result: {
		tool_name: string;
		content: string;
	};
};

// Image content
type ImageBlock = {
	type: 'image';
	url: string;
	mimeType?: string;
};
```

### Accessing Content Blocks

```typescript
// AIMessage now has contentBlocks property
const response = await model.invoke([message]);

for (const block of response.contentBlocks) {
	if (block.type === 'reasoning') {
		console.log('Thinking:', block.reasoning);
	} else if (block.type === 'text') {
		console.log('Response:', block.text);
	}
}
```

## Implementation Plan

### Phase 1: Type Definitions & Message Conversion

**File**: `source/types/core.ts`

Add content block types to Message interface:

```typescript
export interface ContentBlock {
	type: 'text' | 'reasoning' | 'citation' | 'tool_result' | 'image';
	text?: string;
	reasoning?: string;
	citation?: {
		source: string;
		title?: string;
		url?: string;
	};
	tool_result?: {
		tool_name: string;
		content: string;
	};
	image?: {
		url: string;
		mimeType?: string;
	};
}

export interface Message {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	contentBlocks?: ContentBlock[]; // New field
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}
```

**File**: `source/langgraph-client.ts:126-143`

Update message conversion to extract content blocks:

```typescript
function convertFromLangChainMessage(message: AIMessage): Message {
	const result: Message = {
		role: 'assistant',
		content: message.content as string,
	};

	// Extract content blocks if available
	if (message.contentBlocks && message.contentBlocks.length > 0) {
		result.contentBlocks = message.contentBlocks.map(block => {
			// Map LangChain content blocks to our format
			if (block.type === 'reasoning') {
				return {
					type: 'reasoning',
					reasoning: block.reasoning,
				};
			} else if (block.type === 'text') {
				return {
					type: 'text',
					text: block.text,
				};
			} else if (block.type === 'citation') {
				return {
					type: 'citation',
					citation: block.citation,
				};
			}
			// Add other block types as needed
			return block;
		});
	}

	// Tool calls handling (existing)
	if (message.tool_calls && message.tool_calls.length > 0) {
		result.tool_calls = message.tool_calls.map(tc => ({
			id: tc.id || '',
			function: {
				name: tc.name,
				arguments: tc.args,
			},
		}));
	}

	return result;
}
```

### Phase 2: Content Block Rendering Components

**File**: `source/components/content-blocks/reasoning-block.tsx` (new)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';

interface ReasoningBlockProps {
	reasoning: string;
	expanded?: boolean;
}

export const ReasoningBlock: React.FC<ReasoningBlockProps> = ({
	reasoning,
	expanded = false,
}) => {
	const {colors} = useTheme();

	return (
		<Box
			flexDirection="column"
			marginBottom={1}
			borderStyle="round"
			borderColor={colors.dim}
			paddingX={1}
		>
			<Text color={colors.secondary} dimColor>
				💭 Reasoning:
			</Text>
			<Text color={colors.dim} wrap="wrap">
				{expanded ? reasoning : reasoning.slice(0, 200) + '...'}
			</Text>
			{!expanded && reasoning.length > 200 && (
				<Text color={colors.info} dimColor>
					[Use --show-reasoning to see full reasoning]
				</Text>
			)}
		</Box>
	);
};
```

**File**: `source/components/content-blocks/citation-block.tsx` (new)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';

interface CitationBlockProps {
	citation: {
		source: string;
		title?: string;
		url?: string;
	};
}

export const CitationBlock: React.FC<CitationBlockProps> = ({citation}) => {
	const {colors} = useTheme();

	return (
		<Box flexDirection="row" marginBottom={1}>
			<Text color={colors.info}>📚 </Text>
			<Box flexDirection="column">
				{citation.title && <Text color={colors.white}>{citation.title}</Text>}
				<Text color={colors.secondary}>{citation.source}</Text>
				{citation.url && (
					<Text color={colors.dim} dimColor>
						{citation.url}
					</Text>
				)}
			</Box>
		</Box>
	);
};
```

**File**: `source/components/content-blocks/tool-result-block.tsx` (new)

```typescript
import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';

interface ToolResultBlockProps {
	toolName: string;
	content: string;
}

export const ToolResultBlock: React.FC<ToolResultBlockProps> = ({
	toolName,
	content,
}) => {
	const {colors} = useTheme();

	return (
		<Box
			flexDirection="column"
			marginBottom={1}
			borderStyle="round"
			borderColor={colors.tool}
			paddingX={1}
		>
			<Text color={colors.tool}>🔧 {toolName} result:</Text>
			<Text color={colors.white}>{content.slice(0, 300)}</Text>
			{content.length > 300 && (
				<Text color={colors.dim} dimColor>
					... (truncated)
				</Text>
			)}
		</Box>
	);
};
```

**File**: `source/components/content-blocks/index.ts` (new)

```typescript
export {ReasoningBlock} from './reasoning-block';
export {CitationBlock} from './citation-block';
export {ToolResultBlock} from './tool-result-block';
```

### Phase 3: Update AssistantMessage Component

**File**: `source/components/assistant-message.tsx`

Integrate content blocks rendering:

```typescript
import {Text, Box} from 'ink';
import {memo, useMemo} from 'react';
import {useTheme} from '@/hooks/useTheme';
import type {AssistantMessageProps, Colors} from '@/types/index';
import {ReasoningBlock, CitationBlock, ToolResultBlock} from './content-blocks';
import chalk from 'chalk';
import {highlight} from 'cli-highlight';

// ... existing parseMarkdown function ...

export default memo(function AssistantMessage({
	message,
	model,
	contentBlocks,
	showReasoning = false, // New prop
}: AssistantMessageProps) {
	const {colors} = useTheme();

	const renderedMessage = useMemo(() => {
		try {
			return parseMarkdown(message, colors);
		} catch {
			return message;
		}
	}, [message, colors]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box marginBottom={1}>
				<Text color={colors.primary} bold>
					{model}:
				</Text>
			</Box>

			{/* Render content blocks if available */}
			{contentBlocks && contentBlocks.length > 0 && (
				<Box flexDirection="column">
					{contentBlocks.map((block, index) => {
						switch (block.type) {
							case 'reasoning':
								return showReasoning ? (
									<ReasoningBlock
										key={index}
										reasoning={block.reasoning || ''}
										expanded={showReasoning}
									/>
								) : null;

							case 'citation':
								return (
									<CitationBlock
										key={index}
										citation={
											block.citation || {source: '', title: '', url: ''}
										}
									/>
								);

							case 'tool_result':
								return (
									<ToolResultBlock
										key={index}
										toolName={block.tool_result?.tool_name || ''}
										content={block.tool_result?.content || ''}
									/>
								);

							case 'text':
								// Text blocks are rendered below with main message
								return null;

							default:
								return null;
						}
					})}
				</Box>
			)}

			{/* Main text content */}
			<Text>{renderedMessage}</Text>
		</Box>
	);
});
```

### Phase 4: User Preferences for Content Blocks

**File**: `source/config/preferences.ts`

Add content block preferences:

```typescript
export interface UserPreferences {
	// Existing preferences...
	lastProvider?: string;
	lastModel?: Record<string, string>;
	theme?: string;

	// New: Content block preferences
	showReasoning?: boolean; // Default: false
	showCitations?: boolean; // Default: true
	showToolResults?: boolean; // Default: true
}

export const defaultPreferences: UserPreferences = {
	// Existing defaults...
	showReasoning: false, // Hidden by default (can be verbose)
	showCitations: true,
	showToolResults: true,
};
```

### Phase 5: CLI Flag for Reasoning Display

Add a command-line flag to enable reasoning display:

**File**: `source/hooks/useChatHandler.tsx`

Pass `showReasoning` preference to message rendering:

```typescript
export function useChatHandler({
	preferences,
	// ... other params
}) {
	const showReasoning = preferences.showReasoning || false;

	// Pass to message rendering
	return {
		// ... existing returns
		showReasoning,
	};
}
```

**File**: `source/app.tsx`

Pass through to AssistantMessage:

```typescript
<AssistantMessage
	message={msg.content}
	model={getCurrentModel()}
	contentBlocks={msg.contentBlocks}
	showReasoning={showReasoning}
/>
```

### Phase 6: Add Toggle Command

**File**: `source/commands/toggle-reasoning.ts` (new)

```typescript
import type {CommandHandler} from '@/types/commands';

export const toggleReasoningCommand: CommandHandler = async ({
	preferences,
	savePreferences,
	setInfoMessage,
}) => {
	const newValue = !preferences.showReasoning;
	const updatedPreferences = {
		...preferences,
		showReasoning: newValue,
	};

	await savePreferences(updatedPreferences);

	setInfoMessage(
		`Reasoning display ${newValue ? 'enabled' : 'disabled'}. ${
			newValue
				? 'Models will show their thinking process.'
				: 'Only final responses will be shown.'
		}`,
	);

	return {handled: true};
};
```

**File**: `source/commands/index.ts`

Register the command:

```typescript
import {toggleReasoningCommand} from './toggle-reasoning';

export const commands: Record<string, CommandHandler> = {
	// Existing commands...
	'/reasoning': toggleReasoningCommand,
};
```

## Testing Strategy

### Unit Tests

**File**: `source/components/content-blocks/__tests__/reasoning-block.spec.tsx`

```typescript
import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {ReasoningBlock} from '../reasoning-block';

test('ReasoningBlock renders reasoning text', t => {
	const {lastFrame} = render(
		<ReasoningBlock reasoning="This is my thought process" />,
	);

	t.true(lastFrame().includes('This is my thought process'));
	t.true(lastFrame().includes('💭'));
});

test('ReasoningBlock truncates long reasoning by default', t => {
	const longReasoning = 'x'.repeat(300);
	const {lastFrame} = render(<ReasoningBlock reasoning={longReasoning} />);

	t.true(lastFrame().includes('...'));
	t.false(lastFrame().includes('x'.repeat(300)));
});

test('ReasoningBlock shows full reasoning when expanded', t => {
	const longReasoning = 'x'.repeat(300);
	const {lastFrame} = render(
		<ReasoningBlock reasoning={longReasoning} expanded={true} />,
	);

	t.true(lastFrame().includes('x'.repeat(300)));
});
```

### Integration Tests

**File**: `source/langgraph-client.spec.ts` (add tests)

```typescript
test('convertFromLangChainMessage extracts content blocks', t => {
	const aiMessage = new AIMessage({
		content: 'Final answer',
		contentBlocks: [
			{type: 'reasoning', reasoning: 'Let me think...'},
			{type: 'text', text: 'Final answer'},
		],
	});

	const converted = convertFromLangChainMessage(aiMessage);

	t.is(converted.contentBlocks?.length, 2);
	t.is(converted.contentBlocks?.[0].type, 'reasoning');
	t.is(converted.contentBlocks?.[0].reasoning, 'Let me think...');
});
```

### Manual Testing

1. **Test with Claude (Extended Thinking)**:

   - Use Claude Sonnet with `<thinking>` tags
   - Verify reasoning block appears when `/reasoning` is enabled
   - Verify it's hidden by default

2. **Test with OpenAI o1**:

   - Use o1-preview or o1-mini
   - Verify reasoning traces display correctly
   - Check truncation for long reasoning

3. **Test with models without reasoning**:

   - Use GPT-4o or other standard models
   - Verify no reasoning blocks appear (graceful degradation)
   - Ensure no errors or UI issues

4. **Test `/reasoning` toggle**:
   - Enable/disable reasoning display
   - Verify preference persists across restarts
   - Check info message displays correctly

## Edge Cases

### 1. Models Without Content Blocks

If `message.contentBlocks` is undefined or empty:

- Display only text content (existing behavior)
- No errors or UI issues

### 2. Mixed Content

Some blocks may be text + reasoning:

- Render reasoning first (if enabled)
- Then render main text content below

### 3. Very Long Reasoning

Some models (like o1) can have extremely long reasoning:

- Truncate to 200 characters by default
- Show full reasoning only when `showReasoning` is enabled
- Consider pagination for very long traces (future enhancement)

### 4. Invalid Block Types

If LangChain adds new block types:

- Gracefully ignore unknown types
- Log warning for debugging
- Don't crash the UI

## Performance Considerations

### Memoization

Content blocks should be memoized to prevent unnecessary re-renders:

```typescript
const renderedBlocks = useMemo(() => {
	return contentBlocks?.map((block, index) => {
		// Render logic...
	});
}, [contentBlocks, showReasoning]);
```

### Static Components

Content blocks are part of assistant messages, which are moved to `Static`:

- Once rendered, they never re-render
- No performance impact on chat queue

## Configuration

No configuration needed in `agents.config.json` - content blocks are automatically extracted from LangChain responses.

User preferences in `nanocoder-preferences.json`:

```json
{
	"showReasoning": false,
	"showCitations": true,
	"showToolResults": true
}
```

## Migration Path

1. **Phase 1-2**: Implement types and conversion (1-2 hours)
2. **Phase 3**: Create rendering components (2-3 hours)
3. **Phase 4**: Update AssistantMessage (1 hour)
4. **Phase 5-6**: Add preferences and toggle command (1 hour)
5. **Testing**: Manual and automated tests (2-3 hours)

**Total estimated effort**: 8-10 hours

## Success Criteria

- [ ] Content blocks are extracted from LangChain responses
- [ ] Reasoning blocks display with Claude, o1, and other models
- [ ] Citations and tool results render correctly
- [ ] `/reasoning` command toggles reasoning display
- [ ] Preference persists across sessions
- [ ] No performance degradation
- [ ] Tests pass for all block types
- [ ] Graceful handling of models without content blocks

## Future Enhancements

1. **Reasoning Pagination**: For very long reasoning traces (1000+ chars)
2. **Image Block Support**: Display images in terminal (via iTerm2, kitty protocols)
3. **Interactive Citations**: Allow clicking citations to open URLs
4. **Reasoning Export**: Save reasoning traces to file for analysis
5. **Block Filtering**: Hide/show specific block types per conversation

## References

- [LangChain v1.0 Content Blocks Docs](https://docs.langchain.com/oss/javascript/langchain/messages#standard-content-blocks)
- [Message Content Blocks Reference](https://docs.langchain.com/oss/javascript/langchain/messages#content-block-reference)
- [Multimodal Content Guide](https://docs.langchain.com/oss/javascript/langchain/messages#multimodal)
