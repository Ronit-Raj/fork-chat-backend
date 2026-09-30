import type { ServerResponse } from 'node:http';
import { createUIMessageStream, generateText, pipeUIMessageStreamToResponse, streamText, toUIMessageStream, type ModelMessage } from 'ai';
import { google } from '@ai-sdk/google';

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

// The models a client is allowed to pick between. Ids are Google Generative AI
// model ids, handed straight to `google(...)`. The list is an allowlist, not a
// suggestion: `POST /message/:chatid` rejects anything not in it, so a client
// can't make the backend bill an arbitrary model.
export const MODELS = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    description: 'Balanced quality and speed',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    description: 'Fastest and cheapest',
  },
  {
    id: 'gemma-4-31b-it',
    label: 'Gemma 4 31B',
    description: 'Open-weight, instruction tuned',
  },
] as const satisfies readonly ModelOption[];

export type ModelId = (typeof MODELS)[number]['id'];

export const DEFAULT_MODEL_ID: ModelId = 'gemini-3.5-flash';

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && MODELS.some((model) => model.id === value);
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Titles are cheap and latency-sensitive, so they always use the fastest model
// rather than whatever the user picked for the reply.
const TITLE_MODEL_ID: ModelId = 'gemini-3.5-flash-lite';
const TITLE_MAX_LENGTH = 60;
const TITLE_TIMEOUT_MS = 8000;

// Names a chat from its first user message. Resolves to null on any failure so
// a flaky title call never breaks the chat; the client falls back to a local title.
export async function generateChatTitle(message: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: google(TITLE_MODEL_ID),
      system:
        'Write a short title (2 to 6 words) for a chat that begins with the user message below. ' +
        'Reply with the title only: no quotes, no trailing punctuation, same language as the message.',
      prompt: message.slice(0, 2000),
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    const title = text.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ');
    return title ? title.slice(0, TITLE_MAX_LENGTH) : null;
  } catch (err) {
    console.error('Failed to generate chat title:', err);
    return null;
  }
}

// `title`, when given, is a pending title for this chat; it is sent down the
// same stream as a transient `data-title` part the moment it resolves.
export function streamAssistantReply(
  history: ChatMessage[],
  response: ServerResponse,
  onFinish: (text: string) => void,
  modelId: ModelId = DEFAULT_MODEL_ID,
  title?: Promise<string | null>,
): void {
  const messages: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const result = streamText({
    model: google(modelId),
    messages,
    onFinish: ({ text }) => onFinish(text),
  });

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.merge(toUIMessageStream({ stream: result.stream }));
      const resolved = title ? await title : null;
      if (resolved) writer.write({ type: 'data-title', data: { title: resolved }, transient: true });
    },
  });

  void pipeUIMessageStreamToResponse({ response, stream });
}
