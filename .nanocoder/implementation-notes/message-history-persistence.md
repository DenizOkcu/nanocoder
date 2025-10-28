# Message History Persistence Implementation Note

## Overview

Add persistent message history to Nanocoder using LangChain's `BaseChatMessageHistory` implementations. This allows users to resume conversations across CLI sessions and maintain project-specific conversation context.

## Current State

**File**: `source/hooks/useChatHandler.tsx:57-59`

```typescript
const [messages, setMessages] = React.useState<Message[]>([]);
```

Messages are stored in React state only - lost on CLI exit.

## User Stories

1. **Resume After Restart**: User exits CLI mid-task, restarts later, continues conversation
2. **Project Context**: Each project has its own conversation history
3. **History Review**: User can view past conversations for reference
4. **Selective Clear**: Clear current session but keep history archive
5. **Cross-Machine Sync**: (Future) Share history across machines via cloud storage

## LangChain Message History Options

### 1. FileSystemChatMessageHistory (Recommended)

```typescript
import {FileSystemChatMessageHistory} from '@langchain/community/stores/message/file_system';

const history = new FileSystemChatMessageHistory({
	sessionId: 'project-abc123',
	path: '.nanocoder/history',
});

// Add messages
await history.addMessage(new HumanMessage('Hello'));
await history.addMessage(new AIMessage('Hi there!'));

// Retrieve messages
const messages = await history.getMessages();

// Clear history
await history.clear();
```

### 2. PostgresChatMessageHistory

For shared/cloud deployments (future consideration).

### 3. Custom Implementation

Extend `BaseChatMessageHistory` for specialized needs.

## Architecture Design

### File Structure

```
.nanocoder/
├── history/
│   ├── sessions/
│   │   ├── 2025-01-15-abc123.json      # Individual sessions
│   │   ├── 2025-01-15-def456.json
│   │   └── 2025-01-16-ghi789.json
│   ├── current.json                     # Current active session
│   └── index.json                       # Session metadata index
├── conversation-state.db                # LangGraph state (future)
└── commands/                            # Custom commands (existing)
```

### Session ID Strategy

Generate unique session IDs based on:

1. Project directory (hash of absolute path)
2. Timestamp (date for grouping)
3. Random suffix (uniqueness within same day)

```typescript
import {createHash} from 'crypto';

function generateSessionId(): string {
	const projectPath = process.cwd();
	const projectHash = createHash('sha256')
		.update(projectPath)
		.digest('hex')
		.slice(0, 8);

	const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	const random = Math.random().toString(36).slice(2, 8);

	return `${timestamp}-${projectHash}-${random}`;
}
```

### Message History Manager

**File**: `source/history/message-history-manager.ts` (new)

```typescript
import {FileSystemChatMessageHistory} from '@langchain/community/stores/message/file_system';
import {BaseMessage} from '@langchain/core/messages';
import {Message} from '@/types/core';
import {
	convertToLangChainMessage,
	convertFromLangChainMessage,
} from '@/utils/message-converter';
import fs from 'fs/promises';
import path from 'path';

interface SessionMetadata {
	sessionId: string;
	projectPath: string;
	startTime: number;
	lastActive: number;
	messageCount: number;
	firstMessage?: string;
}

export class MessageHistoryManager {
	private historyPath: string;
	private currentSessionId: string | null = null;
	private history: FileSystemChatMessageHistory | null = null;
	private indexPath: string;

	constructor(basePath: string = '.nanocoder/history') {
		this.historyPath = path.join(process.cwd(), basePath);
		this.indexPath = path.join(this.historyPath, 'index.json');
	}

	/**
	 * Initialize history directory
	 */
	async initialize(): Promise<void> {
		await fs.mkdir(path.join(this.historyPath, 'sessions'), {recursive: true});

		// Load or create index
		try {
			await fs.access(this.indexPath);
		} catch {
			await this.saveIndex([]);
		}
	}

	/**
	 * Start a new session or resume existing
	 */
	async startSession(sessionId?: string): Promise<string> {
		await this.initialize();

		this.currentSessionId = sessionId || generateSessionId();
		this.history = new FileSystemChatMessageHistory({
			sessionId: this.currentSessionId,
			path: path.join(this.historyPath, 'sessions'),
		});

		// Update metadata
		await this.updateSessionMetadata({
			sessionId: this.currentSessionId,
			projectPath: process.cwd(),
			startTime: Date.now(),
			lastActive: Date.now(),
			messageCount: 0,
		});

		return this.currentSessionId;
	}

	/**
	 * Add message to current session
	 */
	async addMessage(message: Message): Promise<void> {
		if (!this.history) {
			throw new Error('No active session. Call startSession() first.');
		}

		const langchainMessage = convertToLangChainMessage(message);
		await this.history.addMessage(langchainMessage);

		// Update metadata
		await this.updateLastActive();
	}

	/**
	 * Add multiple messages (bulk)
	 */
	async addMessages(messages: Message[]): Promise<void> {
		if (!this.history) {
			throw new Error('No active session. Call startSession() first.');
		}

		for (const message of messages) {
			await this.addMessage(message);
		}
	}

	/**
	 * Get all messages from current session
	 */
	async getMessages(): Promise<Message[]> {
		if (!this.history) return [];

		const langchainMessages = await this.history.getMessages();
		return langchainMessages.map(convertFromLangChainMessage);
	}

	/**
	 * Clear current session
	 */
	async clearSession(): Promise<void> {
		if (!this.history) return;

		await this.history.clear();
		await this.updateSessionMetadata({
			sessionId: this.currentSessionId!,
			messageCount: 0,
			lastActive: Date.now(),
		});
	}

	/**
	 * List all sessions for current project
	 */
	async listSessions(): Promise<SessionMetadata[]> {
		const index = await this.loadIndex();
		const projectPath = process.cwd();

		return index
			.filter(session => session.projectPath === projectPath)
			.sort((a, b) => b.lastActive - a.lastActive);
	}

	/**
	 * Load session by ID
	 */
	async loadSession(sessionId: string): Promise<Message[]> {
		const history = new FileSystemChatMessageHistory({
			sessionId,
			path: path.join(this.historyPath, 'sessions'),
		});

		const langchainMessages = await history.getMessages();
		return langchainMessages.map(convertFromLangChainMessage);
	}

	/**
	 * Delete old sessions (cleanup)
	 */
	async deleteOldSessions(daysOld: number = 30): Promise<number> {
		const index = await this.loadIndex();
		const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

		let deletedCount = 0;
		const updatedIndex: SessionMetadata[] = [];

		for (const session of index) {
			if (session.lastActive < cutoffTime) {
				// Delete session file
				const sessionPath = path.join(
					this.historyPath,
					'sessions',
					`${session.sessionId}.json`,
				);
				try {
					await fs.unlink(sessionPath);
					deletedCount++;
				} catch {
					// File might not exist, ignore
				}
			} else {
				updatedIndex.push(session);
			}
		}

		await this.saveIndex(updatedIndex);
		return deletedCount;
	}

	/**
	 * Get current session ID
	 */
	getCurrentSessionId(): string | null {
		return this.currentSessionId;
	}

	// Private methods

	private async loadIndex(): Promise<SessionMetadata[]> {
		try {
			const data = await fs.readFile(this.indexPath, 'utf-8');
			return JSON.parse(data);
		} catch {
			return [];
		}
	}

	private async saveIndex(index: SessionMetadata[]): Promise<void> {
		await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2));
	}

	private async updateSessionMetadata(
		metadata: Partial<SessionMetadata> & {sessionId: string},
	): Promise<void> {
		const index = await this.loadIndex();
		const existingIndex = index.findIndex(
			s => s.sessionId === metadata.sessionId,
		);

		if (existingIndex >= 0) {
			// Update existing
			index[existingIndex] = {...index[existingIndex], ...metadata};
		} else {
			// Add new
			index.push(metadata as SessionMetadata);
		}

		await this.saveIndex(index);
	}

	private async updateLastActive(): Promise<void> {
		if (!this.currentSessionId) return;

		const messages = await this.getMessages();
		await this.updateSessionMetadata({
			sessionId: this.currentSessionId,
			lastActive: Date.now(),
			messageCount: messages.length,
			firstMessage: messages[0]?.content?.slice(0, 100),
		});
	}
}

// Helper function (move to utils)
function generateSessionId(): string {
	const projectPath = process.cwd();
	const projectHash = createHash('sha256')
		.update(projectPath)
		.digest('hex')
		.slice(0, 8);

	const timestamp = new Date().toISOString().split('T')[0];
	const random = Math.random().toString(36).slice(2, 8);

	return `${timestamp}-${projectHash}-${random}`;
}
```

### Message Converter Utilities

**File**: `source/utils/message-converter.ts` (new)

Extract conversion logic from `langgraph-client.ts`:

```typescript
import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	BaseMessage,
} from '@langchain/core/messages';
import type {Message} from '@/types/core';

export function convertToLangChainMessage(message: Message): BaseMessage {
	switch (message.role) {
		case 'user':
			return new HumanMessage(message.content || '');
		case 'system':
			return new SystemMessage(message.content || '');
		case 'assistant':
			if (message.tool_calls && message.tool_calls.length > 0) {
				return new AIMessage({
					content: message.content || '',
					tool_calls: message.tool_calls.map(tc => ({
						id: tc.id,
						name: tc.function.name,
						args: tc.function.arguments,
					})),
				});
			}
			return new AIMessage(message.content || '');
		case 'tool':
			return new ToolMessage({
				content: message.content || '',
				tool_call_id: message.tool_call_id || '',
				name: message.name || '',
			});
		default:
			throw new Error(`Unsupported message role: ${(message as any).role}`);
	}
}

export function convertFromLangChainMessage(message: BaseMessage): Message {
	// Implementation depends on message type
	if (message._getType() === 'human') {
		return {
			role: 'user',
			content: message.content as string,
		};
	}

	if (message._getType() === 'ai') {
		const aiMsg = message as AIMessage;
		const result: Message = {
			role: 'assistant',
			content: aiMsg.content as string,
		};

		if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
			result.tool_calls = aiMsg.tool_calls.map(tc => ({
				id: tc.id || '',
				function: {
					name: tc.name,
					arguments: tc.args,
				},
			}));
		}

		return result;
	}

	if (message._getType() === 'tool') {
		const toolMsg = message as ToolMessage;
		return {
			role: 'tool',
			content: toolMsg.content as string,
			tool_call_id: toolMsg.tool_call_id,
			name: toolMsg.name,
		};
	}

	if (message._getType() === 'system') {
		return {
			role: 'system',
			content: message.content as string,
		};
	}

	throw new Error(`Unsupported message type: ${message._getType()}`);
}
```

## Integration with Nanocoder

### Update App Initialization Hook

**File**: `source/hooks/useAppInitialization.tsx`

Add history manager initialization:

```typescript
import {MessageHistoryManager} from '@/history/message-history-manager';

export function useAppInitialization() {
	const [historyManager, setHistoryManager] =
		React.useState<MessageHistoryManager | null>(null);

	React.useEffect(() => {
		async function initHistory() {
			const manager = new MessageHistoryManager();
			await manager.initialize();

			// Check for auto-resume preference
			const shouldResume = await shouldAutoResume();

			if (shouldResume) {
				const sessions = await manager.listSessions();
				if (sessions.length > 0) {
					// Resume most recent session
					const messages = await manager.loadSession(sessions[0].sessionId);
					setMessages(messages);
					await manager.startSession(sessions[0].sessionId);
				} else {
					// Start new session
					await manager.startSession();
				}
			} else {
				// Always start new session
				await manager.startSession();
			}

			setHistoryManager(manager);
		}

		initHistory();
	}, []);

	return {historyManager /* other state */};
}
```

### Update Chat Handler to Persist Messages

**File**: `source/hooks/useChatHandler.tsx`

```typescript
export function useChatHandler({
	historyManager,
	// ... other props
}) {
	const sendMessage = async (userMessage: string) => {
		// Add user message to history
		const userMsg: Message = {role: 'user', content: userMessage};
		await historyManager?.addMessage(userMsg);

		// ... existing LLM call logic ...

		// Add assistant response to history
		const assistantMsg = response.choices[0].message;
		await historyManager?.addMessage(assistantMsg);

		// Add tool results to history
		for (const toolResult of toolResults) {
			await historyManager?.addMessage({
				role: 'tool',
				content: toolResult.content,
				tool_call_id: toolResult.tool_call_id,
				name: toolResult.name,
			});
		}
	};

	return {sendMessage /* ... */};
}
```

### Add Keyboard Shortcuts

**File**: `source/app.tsx`

```typescript
// Existing: Ctrl+C to exit, Ctrl+L to clear
// New shortcuts:
// Ctrl+H: Show history
// Ctrl+R: Resume last session
// Ctrl+N: Start new session

useInput((input, key) => {
	if (key.ctrl && input === 'h') {
		setMode('history');
	}

	if (key.ctrl && input === 'r') {
		resumeLastSession();
	}

	if (key.ctrl && input === 'n') {
		startNewSession();
	}
});
```

### History Browser Component

**File**: `source/components/history-browser.tsx` (new)

```typescript
import React from 'react';
import {Box, Text} from 'ink';
import SelectInput from 'ink-select-input';
import {MessageHistoryManager} from '@/history/message-history-manager';

interface HistoryBrowserProps {
	historyManager: MessageHistoryManager;
	onSelect: (sessionId: string) => void;
	onCancel: () => void;
}

export const HistoryBrowser: React.FC<HistoryBrowserProps> = ({
	historyManager,
	onSelect,
	onCancel,
}) => {
	const [sessions, setSessions] = React.useState<any[]>([]);

	React.useEffect(() => {
		async function loadSessions() {
			const sessionList = await historyManager.listSessions();
			setSessions(sessionList);
		}
		loadSessions();
	}, [historyManager]);

	const items = sessions.map(session => ({
		label: `${session.sessionId} - ${
			session.messageCount
		} messages - ${new Date(session.lastActive).toLocaleString()}`,
		value: session.sessionId,
	}));

	return (
		<Box flexDirection="column">
			<Text bold>Conversation History</Text>
			<Text dimColor>Select a session to resume:</Text>
			<SelectInput items={items} onSelect={item => onSelect(item.value)} />
			<Text dimColor>Press Esc to cancel</Text>
		</Box>
	);
};
```

## Configuration Options

Add to `nanocoder-preferences.json`:

```json
{
	"history": {
		"enabled": true,
		"autoResume": true, // Resume last session on startup
		"persistLocation": ".nanocoder/history",
		"maxSessions": 50, // Keep last 50 sessions
		"maxAge": 30, // Delete sessions older than 30 days
		"excludeToolMessages": false // Option to exclude tool messages from history
	}
}
```

## CLI Commands

Add new slash commands:

### /history

Show conversation history browser

**File**: `.nanocoder/commands/history.md`

```markdown
---
description: View and manage conversation history
---

Show the conversation history browser to view past sessions and resume them.
```

### /resume

Resume last session

**File**: `.nanocoder/commands/resume.md`

```markdown
---
description: Resume the last conversation session
---

Automatically resume the most recent conversation session for this project.
```

### /history-clear

Clear old sessions

**File**: `.nanocoder/commands/history-clear.md`

```markdown
---
description: Clear old conversation history
parameters:
  days:
    type: number
    description: Delete sessions older than this many days
    default: 30
---

Delete old conversation sessions to free up space. Sessions older than {{days}} days will be permanently deleted.
```

## Edge Cases & Considerations

### 1. Large Message History

- **Problem**: Loading thousands of messages on startup is slow
- **Solution**: Implement pagination, only load recent N messages
- **Config**: `maxMessagesToLoad: 100`

### 2. Context Window Limits

- **Problem**: Full history might exceed model context
- **Solution**: Summarize old messages, keep recent ones verbatim
- **Future**: Integrate with LangChain's context summarization

### 3. Tool Message Verbosity

- **Problem**: Tool results can be very large (file contents)
- **Solution**: Option to exclude tool messages or truncate them
- **Config**: `excludeToolMessages` or `truncateToolMessages: 1000`

### 4. Migration from In-Memory

- **Problem**: Users have active conversations when updating
- **Solution**: Auto-save current state on first run with persistence

### 5. Git Conflicts

- **Problem**: `.nanocoder/history/` might cause merge conflicts
- **Solution**: Add to `.gitignore` by default, offer opt-in versioning

### 6. Privacy Concerns

- **Problem**: History might contain sensitive information
- **Solution**:
  - Warn users to add `.nanocoder/` to `.gitignore`
  - Provide `/history-encrypt` command with password protection
  - Respect `.env` and `.gitignore` patterns

## Testing Strategy

### Unit Tests

```typescript
// test: message conversion
test('converts Message to LangChain format and back', () => {
	const original: Message = {
		role: 'user',
		content: 'Hello',
	};

	const langchain = convertToLangChainMessage(original);
	const converted = convertFromLangChainMessage(langchain);

	expect(converted).toEqual(original);
});

// test: session ID generation
test('session IDs are unique per project', () => {
	const id1 = generateSessionId();
	const id2 = generateSessionId();
	expect(id1).not.toEqual(id2);
});

// test: history manager
test('adds and retrieves messages', async () => {
	const manager = new MessageHistoryManager();
	await manager.startSession('test-session');

	await manager.addMessage({role: 'user', content: 'Test'});
	const messages = await manager.getMessages();

	expect(messages).toHaveLength(1);
	expect(messages[0].content).toBe('Test');
});
```

### Integration Tests

```typescript
test('persists messages across manager instances', async () => {
	const manager1 = new MessageHistoryManager();
	const sessionId = await manager1.startSession();
	await manager1.addMessage({role: 'user', content: 'Persistent'});

	// Create new instance (simulate restart)
	const manager2 = new MessageHistoryManager();
	const messages = await manager2.loadSession(sessionId);

	expect(messages).toHaveLength(1);
	expect(messages[0].content).toBe('Persistent');
});
```

### Manual Tests

- [ ] Create conversation, exit CLI, restart, resume conversation
- [ ] Multiple projects maintain separate histories
- [ ] History browser shows correct session list
- [ ] Old sessions are cleaned up after 30 days
- [ ] Large histories (1000+ messages) load performantly

## Migration Strategy

### Phase 1: Implementation (Week 1)

- Implement `MessageHistoryManager`
- Add message conversion utilities
- Unit tests for core functionality

### Phase 2: Integration (Week 2)

- Integrate with `useChatHandler`
- Add history browser UI component
- Keyboard shortcuts and slash commands

### Phase 3: Testing (Week 3)

- Integration tests
- Manual testing across different scenarios
- Performance optimization

### Phase 4: Rollout (Week 4)

- Feature flag: `ENABLE_HISTORY_PERSISTENCE`
- Default OFF initially
- Gather feedback from early adopters
- Enable by default after validation

## Performance Optimization

### Lazy Loading

```typescript
// Only load message metadata initially
interface MessageMetadata {
  role: string;
  timestamp: number;
  preview: string; // First 50 chars
}

// Load full messages on demand
async getMessageContent(index: number): Promise<Message> {
  // Load from file only when needed
}
```

### Compression

```typescript
// Compress old sessions to save space
import {gzip, gunzip} from 'zlib';
import {promisify} from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

async function compressSession(sessionId: string) {
	const data = await fs.readFile(`sessions/${sessionId}.json`);
	const compressed = await gzipAsync(data);
	await fs.writeFile(`sessions/${sessionId}.json.gz`, compressed);
	await fs.unlink(`sessions/${sessionId}.json`);
}
```

## Success Criteria

- [ ] Conversations persist across CLI restarts
- [ ] Each project has independent history
- [ ] History browser shows sessions with metadata
- [ ] Performance: Load time <500ms for 100 messages
- [ ] Disk usage: <1MB per 100 messages
- [ ] Zero data loss during normal operation
- [ ] Cleanup removes old sessions correctly

## Estimated Effort

- **Core Implementation**: 8-10 hours
- **UI Components**: 4-6 hours
- **Testing**: 6-8 hours
- **Documentation**: 2-3 hours
- **Total**: 20-27 hours (3-4 days)

## Future Enhancements

1. **Cloud Sync**: Sync history across machines via S3/Dropbox
2. **Export/Import**: Export conversations as markdown or JSON
3. **Search**: Full-text search across conversation history
4. **Analytics**: Track most-used commands, common issues
5. **Collaboration**: Share conversation sessions with team members
6. **Encryption**: Encrypt sensitive conversations at rest
