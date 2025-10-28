import React from 'react';
import {Text, Box} from 'ink';
import {useTheme} from '@/hooks/useTheme';
import type {Colors} from '@/types/index';
import chalk from 'chalk';
import {highlight} from 'cli-highlight';

// Basic markdown parser for terminal (same as AssistantMessage)
function parseMarkdown(text: string, themeColors: Colors): string {
	let result = text;

	// Code blocks (```language\ncode\n```)
	result = result.replace(
		/```(\w+)?\n([\s\S]*?)```/g,
		(_match, lang: string | undefined, code: string) => {
			try {
				const codeStr = String(code).trim();
				// Apply syntax highlighting with detected language
				const highlighted = highlight(codeStr, {
					language: lang || 'plaintext',
					theme: 'default',
				});
				return highlighted;
			} catch {
				// Fallback to plain colored text if highlighting fails
				return chalk.hex(themeColors.tool)(String(code).trim());
			}
		},
	);

	// Inline code (`code`)
	result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
		return chalk.hex(themeColors.tool)(String(code).trim());
	});

	// Bold (**text** or __text__)
	result = result.replace(/\*\*([^*]+)\*\*/g, (_match, text) => {
		return chalk.hex(themeColors.white).bold(text);
	});
	result = result.replace(/__([^_]+)__/g, (_match, text) => {
		return chalk.hex(themeColors.white).bold(text);
	});

	// Italic (*text* or _text_)
	result = result.replace(/\*([^*]+)\*/g, (_match, text) => {
		return chalk.hex(themeColors.white).italic(text);
	});
	result = result.replace(/_([^_]+)_/g, (_match, text) => {
		return chalk.hex(themeColors.white).italic(text);
	});

	// Headings (# Heading)
	result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, text) => {
		return chalk.hex(themeColors.primary).bold(text);
	});

	// Links [text](url)
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
		return (
			chalk.hex(themeColors.info).underline(text) +
			' ' +
			chalk.hex(themeColors.secondary)(`(${url})`)
		);
	});

	// Blockquotes (> text)
	result = result.replace(/^>\s+(.+)$/gm, (_match, text) => {
		return chalk.hex(themeColors.secondary).italic(`> ${text}`);
	});

	// List items (- item or * item or 1. item)
	result = result.replace(/^[\s]*[-*]\s+(.+)$/gm, (_match, text) => {
		return chalk.hex(themeColors.white)(`• ${text}`);
	});
	result = result.replace(/^[\s]*\d+\.\s+(.+)$/gm, (_match, text) => {
		return chalk.hex(themeColors.white)(text);
	});

	return result;
}

interface StreamingMessageProps {
	/** Accumulated content from token stream */
	content: string;

	/** Model name to display in header */
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
			try {
				return parseMarkdown(content, colors);
			} catch {
				// Fallback to plain text if markdown parsing fails
				return content;
			}
		}, [content, colors]);

		return (
			<Box flexDirection="column" marginBottom={1}>
				<Box marginBottom={1}>
					<Text color={colors.primary} bold>
						{model}:
					</Text>
				</Box>
				<Box flexDirection="row">
					<Text>{renderedContent}</Text>
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
