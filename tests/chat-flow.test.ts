import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';

interface StubChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Replaces the real Gemini call with a deterministic SSE stream so tests don't
// depend on network access, an API key, or non-deterministic model output.
// Everything downstream of this boundary (routing, auth, persistence, the
// materialized-path tree) is exercised for real against the dev Postgres db.
const MOCK_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'Balanced quality and speed' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', description: 'Fastest and cheapest' },
  { id: 'gemma-4-31b-it', label: 'Gemma 4 31B', description: 'Open-weight, instruction tuned' },
] as const;

const DEFAULT_MOCK_MODEL = 'gemini-3.5-flash';

// Records the model id each request resolved to, so tests can assert the
// picked model reaches the LLM boundary without making a real call.
const modelsUsed: string[] = [];

vi.mock('../src/llm.js', () => ({
  MODELS: MOCK_MODELS,
  DEFAULT_MODEL_ID: DEFAULT_MOCK_MODEL,
  isModelId: (value: unknown) => MOCK_MODELS.some((m) => m.id === value),
  streamAssistantReply: (
    history: StubChatMessage[],
    response: ServerResponse,
    onFinish: (text: string) => void,
    modelId: string = DEFAULT_MOCK_MODEL,
  ) => {
    modelsUsed.push(modelId);
    const lastUserMessage = history[history.length - 1]!;
    const replyText = `mock reply: ${lastUserMessage.content}`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type: 'text-delta', delta: replyText })}\n\n`);
    response.end();
    onFinish(replyText);
  },
}));

const { app } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 2000, intervalMs = 25): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met before timeout');
}

describe('chat fork flow', () => {
  const email = `test-${randomUUID()}@example.com`;
  const password = 'password123';

  let token: string;
  let userId: string;
  let chatId: string;
  let forkChatId: string;

  afterAll(async () => {
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('signs up a new user and returns a bearer token', async () => {
    const res = await request(app).post('/auth/signup').send({ email, password });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');

    token = res.body.token;
    userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).userId;
    expect(userId).toBeTruthy();
  });

  it('creates a new top-level chat', async () => {
    const res = await request(app).post('/chats').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body.path).toBe(`/${res.body.chatId}`);
    expect(res.body.messages).toEqual([]);

    chatId = res.body.chatId;
  });

  it('reuses the still-empty chat instead of creating a new one', async () => {
    const res = await request(app).post('/chats').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.chatId).toBe(chatId);
    expect(res.body.path).toBe(`/${chatId}`);
    expect(res.body.messages).toEqual([]);
  });

  it('streams a message reply over SSE and persists it', async () => {
    const res = await request(app)
      .post(`/message/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Say hi in two words.' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('mock reply: Say hi in two words.');
    expect(modelsUsed.at(-1)).toBe(DEFAULT_MOCK_MODEL);

    const chat = await waitFor(async () => {
      const c = await prisma.chat.findUnique({ where: { chatId } });
      const messages = c?.messages as StubChatMessage[] | undefined;
      return messages?.length === 2 ? c : null;
    });

    expect(chat.messages).toEqual([
      { role: 'user', content: 'Say hi in two words.' },
      { role: 'assistant', content: 'mock reply: Say hi in two words.' },
    ]);
  });

  it('lists the selectable models', async () => {
    const res = await request(app).get('/models').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.defaultModel).toBe(DEFAULT_MOCK_MODEL);
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemma-4-31b-it',
    ]);
  });

  it('routes a message to the model the client picked', async () => {
    const res = await request(app)
      .post(`/message/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Which model are you?', model: 'gemma-4-31b-it' });

    expect(res.status).toBe(200);
    expect(modelsUsed.at(-1)).toBe('gemma-4-31b-it');

    await waitFor(async () => {
      const c = await prisma.chat.findUnique({ where: { chatId } });
      const messages = c?.messages as StubChatMessage[] | undefined;
      return messages?.length === 4 ? c : null;
    });
  });

  it('rejects an unknown model without calling the LLM', async () => {
    const before = modelsUsed.length;
    const res = await request(app)
      .post(`/message/${chatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'hi', model: 'gpt-definitely-not-allowed' });

    expect(res.status).toBe(400);
    expect(modelsUsed).toHaveLength(before);
  });

  it('forks a chat, creating a new branch with the parent history', async () => {
    const res = await request(app).post(`/fork/${chatId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    forkChatId = res.body.chatId;
    expect(res.body.path).toBe(`/${chatId}/${forkChatId}`);
    expect(res.body.messages).toEqual([
      { role: 'user', content: 'Say hi in two words.' },
      { role: 'assistant', content: 'mock reply: Say hi in two words.' },
      { role: 'user', content: 'Which model are you?' },
      { role: 'assistant', content: 'mock reply: Which model are you?' },
    ]);

    const row = await prisma.chat.findUnique({ where: { chatId: forkChatId } });
    expect(row?.messages).toEqual(res.body.messages);
  });

  it('continues a forked chat with a new message', async () => {
    const res = await request(app)
      .post(`/message/${forkChatId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Now say goodbye in two words.' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('mock reply: Now say goodbye in two words.');

    const forked = await waitFor(async () => {
      const c = await prisma.chat.findUnique({ where: { chatId: forkChatId } });
      const messages = c?.messages as StubChatMessage[] | undefined;
      return messages?.length === 6 ? c : null;
    });

    expect(forked.messages).toEqual([
      { role: 'user', content: 'Say hi in two words.' },
      { role: 'assistant', content: 'mock reply: Say hi in two words.' },
      { role: 'user', content: 'Which model are you?' },
      { role: 'assistant', content: 'mock reply: Which model are you?' },
      { role: 'user', content: 'Now say goodbye in two words.' },
      { role: 'assistant', content: 'mock reply: Now say goodbye in two words.' },
    ]);
  });

  it('lists all descendants of a chat via /children', async () => {
    const res = await request(app).get(`/children/${chatId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].chatId).toBe(forkChatId);
  });

  it('lists only top-level chats via /chats/:userid', async () => {
    const res = await request(app).get(`/chats/${userId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].chatId).toBe(chatId);
  });

  it('cascading deletes a chat and its forks', async () => {
    const del = await request(app).delete(`/${chatId}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const getParent = await request(app).get(`/${chatId}`).set('Authorization', `Bearer ${token}`);
    expect(getParent.status).toBe(404);

    const remaining = await prisma.chat.findMany({ where: { userId } });
    expect(remaining).toHaveLength(0);
  });

  it('rejects requests without a bearer token', async () => {
    const res = await request(app).get(`/${chatId}`);
    expect(res.status).toBe(401);
  });
});
