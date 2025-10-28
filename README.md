# Nanocoder

A local-first CLI coding agent that brings the power of agentic coding tools like Claude Code and Gemini CLI to local models or controlled APIs like OpenRouter. Built with privacy and control in mind, Nanocoder supports multiple AI providers with tool support for file operations and command execution.

![Example](./.github/assets/example.gif)

## Table of Contents

- [FAQs](#faqs)
- [Installation](#installation)
  - [For Users (Recommended)](#for-users-recommended)
  - [For Development](#for-development)
- [Configuration](#configuration)
  - [AI Provider Setup](#ai-provider-setup)
  - [MCP (Model Context Protocol) Servers](#mcp-model-context-protocol-servers)
  - [User Preferences](#user-preferences)
  - [Commands](#commands)
    - [Built-in Commands](#built-in-commands)
    - [Custom Commands](#custom-commands)
- [Features](#features)
  - [Multi-Provider Support](#-multi-provider-support)
  - [Advanced Tool System](#️-advanced-tool-system)
  - [Custom Command System](#-custom-command-system)
  - [Enhanced User Experience](#-enhanced-user-experience)
  - [Developer Features](#️-developer-features)
- [Community](#community)

## FAQs

### What is Nanocoder?

Nanocoder is a local-first CLI coding agent that brings the power of agentic coding tools like Claude Code and Gemini CLI to local models or controlled APIs like OpenRouter. Built with privacy and control in mind, Nanocoder supports any AI provider that has an OpenAI compatible end-point, tool and non-tool calling models.

### How is this different to OpenCode?

This comes down to philosophy. OpenCode is a great tool, but it's owned and managed by a venture-backed company that restricts community and open-source involvement to the outskirts. With Nanocoder, the focus is on building a true community-led project where anyone can contribute openly and directly. We believe AI is too powerful to be in the hands of big corporations and everyone should have access to it.

We also strongly believe in the "local-first" approach, where your data, models, and processing stay on your machine whenever possible to ensure maximum privacy and user control. Beyond that, we're actively pushing to develop advancements and frameworks for small, local models to be effective at coding locally.

Not everyone will agree with this philosophy, and that's okay. We believe in fostering an inclusive community that's focused on open collaboration and privacy-first AI coding tools.

### I want to be involved, how do I start?

Firstly, we would love for you to be involved. You can get started contributing to Nanocoder in several ways, check out the [Community](#community) section of this README.

## Installation

### For Users (Recommended)

Install globally and use anywhere:

```bash
npm install -g @nanocollective/nanocoder
```

Then run in any directory:

```bash
nanocoder
```

### For Development

If you want to contribute or modify Nanocoder:

**Prerequisites:**

- Node.js 18+
- npm

**Setup:**

1. Clone and install dependencies:

```bash
git clone [repo-url]
cd nanocoder
npm install
```

2. Build the project:

```bash
npm run build
```

3. Run locally:

```bash
npm run start
```

Or build and run in one command:

```bash
npm run dev
```

## Configuration

### AI Provider Setup

Nanocoder supports any OpenAI-compatible API through a unified provider configuration. Create `agents.config.json` in your **working directory** (where you run `nanocoder`):

```json
{
	"nanocoder": {
		"providers": [
			{
				"name": "llama-cpp",
				"baseUrl": "http://localhost:8080/v1",
				"models": ["qwen3-coder:a3b", "deepseek-v3.1"]
			},
			{
				"name": "Ollama",
				"baseUrl": "http://localhost:11434/v1",
				"models": ["qwen2.5-coder:14b", "llama3.2"]
			},
			{
				"name": "OpenRouter",
				"baseUrl": "https://openrouter.ai/api/v1",
				"apiKey": "your-openrouter-api-key",
				"models": ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"]
			},
			{
				"name": "LM Studio",
				"baseUrl": "http://localhost:1234/v1",
				"models": ["local-model"]
			},
			{
				"name": "Z.ai",
				"baseUrl": "https://api.z.ai/api/paas/v4/",
				"apiKey": "your-z.ai-api-key",
				"models": ["glm-4.6", "glm-4.5", "glm-4.5-air"]
			},
			{
				"name": "Z.ai Coding Subscription",
				"baseUrl": "https://api.z.ai/api/coding/paas/v4/",
				"apiKey": "your-z.ai-coding-api-key",
				"models": ["glm-4.6", "glm-4.5", "glm-4.5-air"]
			}
		]
	}
}
```

**Common Provider Examples:**

- **llama.cpp server**: `"baseUrl": "http://localhost:8080/v1"`
- **llama-swap**: `"baseUrl": "http://localhost:9292/v1"`
- **Ollama (Local)**: `"baseUrl": "http://localhost:11434/v1"`
- **OpenRouter (Cloud)**: `"baseUrl": "https://openrouter.ai/api/v1"`
- **LM Studio**: `"baseUrl": "http://localhost:1234/v1"`
- **vLLM**: `"baseUrl": "http://localhost:8000/v1"`
- **LocalAI**: `"baseUrl": "http://localhost:8080/v1"`
- **OpenAI**: `"baseUrl": "https://api.openai.com/v1"`
- **Z.ai**: `"baseUrl": "https://api.z.ai/api/paas/v4/"`
- **Z.ai Coding**: `"baseUrl": "https://api.z.ai/api/coding/paas/v4/"`

**Provider Configuration:**

- `name`: Display name used in `/provider` command
- `baseUrl`: OpenAI-compatible API endpoint
- `apiKey`: API key (optional, may not be required)
- `models`: Available model list for `/model` command

**Environment Variables:**

Keep API keys out of version control using environment variables. Variables are loaded from shell environment (`.bashrc`, `.zshrc`) or `.env` file in your working directory.

**Syntax:** `$VAR_NAME`, `${VAR_NAME}`, or `${VAR_NAME:-default}`
**Supported in:** `baseUrl`, `apiKey`, `models`, MCP server `command`, `args`, `env`

See `.env.example` for setup instructions

**Timeout Configuration:**

Nanocoder allows you to configure timeouts for your AI providers to handle long-running requests.

- `requestTimeout`: (Optional) The application-level timeout in milliseconds. This is the total time the application will wait for a response from the provider. If not set, it defaults to 2 minutes (120,000 ms). Set to `-1` to disable this timeout.
- `socketTimeout`: (Optional) The socket-level timeout in milliseconds. This controls the timeout for the underlying network connection. If not set, it will use the value of `requestTimeout`. Set to `-1` to disable this timeout.

It is recommended to set both `requestTimeout` and `socketTimeout` to the same value for consistent behavior. For very long-running requests, you can disable timeouts by setting both to `-1`.

- `connectionPool`: (Optional) An object to configure the connection pooling behavior for the underlying socket connection.
  - `idleTimeout`: (Optional) The timeout in milliseconds for how long an idle connection should be kept alive in the pool. Defaults to 4 seconds (4,000 ms).
  - `cumulativeMaxIdleTimeout`: (Optional) The maximum time in milliseconds a connection can be idle. Defaults to 10 minutes (600,000 ms).

**Example with Timeouts:**

```json
{
	"nanocoder": {
		"providers": [
			{
				"name": "llama-cpp",
				"baseUrl": "http://localhost:8080/v1",
				"models": ["qwen3-coder:a3b", "deepseek-v3.1"],
				"requestTimeout": -1,
				"socketTimeout": -1,
				"connectionPool": {
					"idleTimeout": 30000,
					"cumulativeMaxIdleTimeout": 3600000
				}
			}
		]
	}
}
```

**Streaming Configuration:**

Nanocoder supports real-time token streaming for LLM responses, displaying AI output as it's generated instead of waiting for complete responses. Streaming is enabled by default but can be disabled per-provider:

- `streaming`: (Optional) Enable/disable real-time streaming for this provider. Defaults to `true`.

**When to disable streaming:**

- Local models with slow inference (Ollama on CPU)
- Terminal emulators with poor rendering performance
- Preference for complete responses only

**Example with Streaming Configuration:**

```json
{
	"nanocoder": {
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
}
```

**Troubleshooting Context Length Issues:**

If you experience the model repeating tool calls or getting into loops (especially with multi-turn conversations), this is often caused by insufficient context length settings in your local AI provider:

- **LM Studio**: Increase "Context Length" in Settings → Model Settings (recommended: 8192 or higher)
- **Ollama**: Set context length with `OLLAMA_NUM_CTX=8192`
- **llama.cpp**: Use `--ctx-size 8192` or higher when starting the server
- **vLLM**: Set `--max-model-len 8192` when launching

Tool-calling conversations require more context to track the history of tool calls and their results. If the context window is too small, the model may lose track of previous actions and repeat them indefinitely.

### MCP (Model Context Protocol) Servers

Nanocoder supports connecting to MCP servers to extend its capabilities with additional tools. Configure MCP servers in your `agents.config.json`:

```json
{
	"nanocoder": {
		"mcpServers": [
			{
				"name": "filesystem",
				"command": "npx",
				"args": [
					"@modelcontextprotocol/server-filesystem",
					"/path/to/allowed/directory"
				]
			},
			{
				"name": "github",
				"command": "npx",
				"args": ["@modelcontextprotocol/server-github"],
				"env": {
					"GITHUB_TOKEN": "your-github-token"
				}
			},
			{
				"name": "custom-server",
				"command": "python",
				"args": ["path/to/server.py"],
				"env": {
					"API_KEY": "your-api-key"
				}
			}
		]
	}
}
```

**MCP Server Configuration:**

- `name`: Display name for the MCP server
- `command`: Executable command to start the server
- `args`: Array of command-line arguments
- `env`: Environment variables for the server process

When MCP servers are configured, Nanocoder will:

- Automatically connect to all configured servers on startup
- Make all server tools available to the AI model
- Show connected servers and their tools with the `/mcp` command

Popular MCP servers:

- **Filesystem**: Enhanced file operations
- **GitHub**: Repository management
- **Brave Search**: Web search capabilities
- **Memory**: Persistent context storage
- [View more MCP servers](https://github.com/modelcontextprotocol/servers)

> **Note**: The default save place for configuration is `~/config/nanocoder/`. You can also place an `agents.config.json` where you run Nanocoder. This will **override** the default for project-by-project configuration with different models or API keys per repository.

### User Preferences

Nanocoder automatically saves your preferences to remember your choices across sessions. Preferences are stored in `~/config/nanocoder/nanocoder-preferences.json`. You can also place a `nanocoder-preferences.json` where you run Nanocoder. This will **override** the default for project-by-project configuration.

**What gets saved automatically:**

- **Last provider used**: The AI provider you last selected (by name from your configuration)
- **Last model per provider**: Your preferred model for each provider
- **Session continuity**: Automatically switches back to your preferred provider/model when restarting
- **Last theme used**: The theme you last selected

**Manual management:**

- View current preferences: The file is human-readable JSON
- Reset preferences: Delete any `nanocoder-preferences.json` to start fresh

### Commands

#### Built-in Commands

- `/help` - Show available commands
- `/init` - Initialize project with intelligent analysis, create AGENTS.md and configuration files
- `/setup-config` - Interactive wizard for configuring AI providers and MCP servers with templates
- `/clear` - Clear chat history
- `/model` - Switch between available models
- `/provider` - Switch between configured AI providers
- `/status` - Display current status (CWD, provider, model, theme, available updates, AGENTS setup)
- `/recommendations` - Get AI model recommendations based on your system capabilities (RAM, GPU, network)
- `/mcp` - Show connected MCP servers and their tools
- `/custom-commands` - List all custom commands
- `/exit` - Exit the application
- `/export` - Export current session to markdown file
- `/theme` - Select a theme for the Nanocoder CLI
- `/update` - Update Nanocoder to the latest version
- `!command` - Execute bash commands directly without leaving Nanocoder (output becomes context for the LLM)

#### Custom Commands

Nanocoder supports custom commands defined as markdown files in the `.nanocoder/commands` directory. Like `agents.config.json`, this directory is created per codebase, allowing you to create reusable prompts with parameters and organize them by category specific to each project.

**Example custom command** (`.nanocoder/commands/test.md`):

```markdown
---
description: 'Generate comprehensive unit tests for the specified component'
aliases: ['testing', 'spec']
parameters:
  - name: 'component'
    description: 'The component or function to test'
    required: true
---

Generate comprehensive unit tests for {{component}}. Include:

- Happy path scenarios
- Edge cases and error handling
- Mock dependencies where appropriate
- Clear test descriptions
```

**Usage**: `/test component="UserService"`

**Features**:

- YAML frontmatter for metadata (description, aliases, parameters)
- Template variable substitution with `{{parameter}}` syntax
- Namespace support through directories (e.g., `/refactor:dry`)
- Autocomplete integration for command discovery
- Parameter validation and prompting

**Pre-installed Commands**:

- `/test` - Generate comprehensive unit tests for components
- `/review` - Perform thorough code reviews with suggestions
- `/refactor:dry` - Apply DRY (Don't Repeat Yourself) principle
- `/refactor:solid` - Apply SOLID design principles

## Features

### Multi-Provider Support

- **Universal OpenAI compatibility**: Works with any OpenAI-compatible API
- **Local providers**: Ollama, LM Studio, vLLM, LocalAI, llama.cpp
- **Cloud providers**: OpenRouter, OpenAI, and other hosted services
- **Smart fallback**: Automatically switches to available providers if one fails
- **Per-provider preferences**: Remembers your preferred model for each provider
- **Dynamic configuration**: Add any provider with just a name and endpoint

### Advanced Tool System

- **Built-in tools**: File operations, bash command execution
- **MCP (Model Context Protocol) servers**: Extend capabilities with any MCP-compatible tool
- **Dynamic tool loading**: Tools are loaded on-demand from configured MCP servers
- **Tool approval**: Optional confirmation before executing potentially destructive operations

### Custom Command System

- **Markdown-based commands**: Define reusable prompts in `.nanocoder/commands/`
- **Template variables**: Use `{{parameter}}` syntax for dynamic content
- **Namespace organization**: Organize commands in folders (e.g., `refactor/dry.md`)
- **Autocomplete support**: Tab completion for command discovery
- **Rich metadata**: YAML frontmatter for descriptions, aliases, and parameters

### Enhanced User Experience

- **Smart autocomplete**: Tab completion for commands with real-time suggestions
- **Colorized output**: Syntax highlighting and structured display
- **Session persistence**: Maintains context and preferences across sessions
- **Real-time indicators**: Shows token usage, timing, and processing status
- **First-time directory security disclaimer**: Prompts on first run and stores a per-project trust decision to prevent accidental exposure of local code or secrets.
- **Development modes**: Three modes to control tool execution behavior (toggle with Shift+Tab)
  - **Normal mode**: Standard tool confirmation flow - review each tool call before execution
  - **Auto-accept mode**: Automatically accepts all tool calls without confirmation for faster workflows
  - **Plan mode**: AI suggests actions but doesn't execute tools - useful for planning and exploration

### Developer Features

- **TypeScript-first**: Full type safety and IntelliSense support
- **Extensible architecture**: Plugin-style system for adding new capabilities
- **Project-specific config**: Different settings per project via `agents.config.json`
- **Error resilience**: Graceful handling of provider failures and network issues

## Community

We're a small community-led team building Nanocoder and would love your help! Whether you're interested in contributing code, documentation, or just being part of our community, there are several ways to get involved.

**If you want to contribute to the code:**

- Read our detailed [CONTRIBUTING.md](CONTRIBUTING.md) guide for information on development setup, coding standards, and how to submit your changes.

**If you want to be part of our community or help with other aspects like design or marketing:**

- Join our Discord server to connect with other users, ask questions, share ideas, and get help: [Join our Discord server](https://discord.gg/ktPDV6rekE)

- Head to our GitHub issues or discussions to open and join current conversations with others in the community.

**What does Nanocoder need help with?**

Nanocoder could benefit from help all across the board. Such as:

- Adding support for new AI providers
- Improving tool functionality
- Enhancing the user experience
- Writing documentation
- Reporting bugs or suggesting features
- Marketing and getting the word out
- Design and building more great software
- Model cards for our recommendations database

All contributions and community participation are welcome!
