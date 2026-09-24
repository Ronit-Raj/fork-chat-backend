import type { ServerResponse } from 'node:http';
import { streamText, type ModelMessage } from 'ai';
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

export function streamAssistantReply(
  history: ChatMessage[],
  response: ServerResponse,
  onFinish: (text: string) => void,
  modelId: ModelId = DEFAULT_MODEL_ID,
): void {
  const messages: ModelMessage[] = history.map((m) => ({ role: m.role, content: m.content }));

  const result = streamText({
    model: google(modelId),
    messages,
    onFinish: ({ text }) => onFinish(text),
  });

  void result.pipeUIMessageStreamToResponse(response);
}
