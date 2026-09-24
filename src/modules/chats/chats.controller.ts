import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import {
  streamAssistantReply,
  isModelId,
  MODELS,
  DEFAULT_MODEL_ID,
  type ChatMessage,
} from '../../llm.js';

function asMessages(messages: Prisma.JsonValue): ChatMessage[] {
  return messages as unknown as ChatMessage[];
}

function childPath(parentPath: string, childId: string): string {
  return `${parentPath}/${childId}`;
}

async function findOwnedChat(chatId: string, userId: string) {
  const chat = await prisma.chat.findUnique({ where: { chatId } });
  if (!chat || chat.userId !== userId) return null;
  return chat;
}

// GET /models - the models the client may choose between, and the default.
// Served from the backend so the allowlist has a single source of truth.
export function listModels(_req: Request, res: Response) {
  res.json({ models: MODELS, defaultModel: DEFAULT_MODEL_ID });
}

// POST /chats - create a new top-level chat (empty, no messages yet).
// If the user's most recently created chat is still empty, reuse it instead
// (200 with the existing chat) rather than creating a duplicate.
export async function createChat(req: Request<{ chatid: string }>, res: Response) {
  const lastChat = await prisma.chat.findFirst({
    where: { userId: req.userId! },
    orderBy: [{ createdAt: 'desc' }, { chatId: 'desc' }],
  });

  if (lastChat && asMessages(lastChat.messages).length === 0) {
    res.status(200).json({ chatId: lastChat.chatId, path: lastChat.path, messages: asMessages(lastChat.messages) });
    return;
  }

  const chatId = randomUUID();
  const chat = await prisma.chat.create({
    data: {
      chatId,
      userId: req.userId!,
      path: `/${chatId}`,
      messages: [] as unknown as Prisma.InputJsonValue,
    },
  });
  res.status(201).json({ chatId: chat.chatId, path: chat.path, messages: [] });
}

// GET /:chatid - return the messages of this chat
export async function getChat(req: Request<{ chatid: string }>, res: Response) {
  const chat = await findOwnedChat(req.params.chatid!, req.userId!);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.json({ chatId: chat.chatId, path: chat.path, messages: asMessages(chat.messages) });
}

// POST /fork/:chatid - create a new fork branch of the given chat, copying its history. No message, no streaming.
export async function forkChat(req: Request<{ chatid: string }>, res: Response) {
  const parent = await findOwnedChat(req.params.chatid!, req.userId!);
  if (!parent) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const newChatId = randomUUID();
  const chat = await prisma.chat.create({
    data: {
      chatId: newChatId,
      userId: req.userId!,
      path: childPath(parent.path, newChatId),
      messages: parent.messages as Prisma.InputJsonValue,
    },
  });

  res.status(201).json({ chatId: chat.chatId, path: chat.path, messages: asMessages(chat.messages) });
}

// POST /message/:chatid - continue an existing chat, stream the reply, persist once finished
export async function sendMessage(req: Request<{ chatid: string }>, res: Response) {
  const chat = await findOwnedChat(req.params.chatid!, req.userId!);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const { message, model } = req.body ?? {};
  if (typeof message !== 'string' || message.length === 0) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // `model` is optional; an unknown one is a client bug, so fail loudly rather
  // than silently answering with a model the user didn't pick.
  if (model !== undefined && !isModelId(model)) {
    res.status(400).json({ error: `Unknown model: ${String(model)}` });
    return;
  }
  const modelId = model ?? DEFAULT_MODEL_ID;

  const chatId = chat.chatId;
  const history: ChatMessage[] = [...asMessages(chat.messages), { role: 'user', content: message }];

  streamAssistantReply(history, res, (assistantText) => {
    const finalMessages: ChatMessage[] = [...history, { role: 'assistant', content: assistantText }];
    prisma.chat
      .update({
        where: { chatId },
        data: { messages: finalMessages as unknown as Prisma.InputJsonValue },
      })
      .catch((err) => console.error(`Failed to persist message for chat ${chatId}:`, err));
  }, modelId);
}

// GET /chats/:userid - top-level chats for a user (path is a single segment, e.g. "/uuid")
export async function listTopLevelChats(req: Request<{ userid: string }>, res: Response) {
  if (req.params.userid !== req.userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const chats = await prisma.$queryRaw<
    { chatId: string; path: string; messages: unknown }[]
  >`SELECT "chatId", "path", "messages" FROM "chats" WHERE "userId" = ${req.userId}::uuid AND "path" ~ '^/[^/]+$'`;

  res.json(chats);
}

// GET /children/:chatid - all descendants of this chat in the fork tree
export async function listChildren(req: Request<{ chatid: string }>, res: Response) {
  const chat = await findOwnedChat(req.params.chatid!, req.userId!);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  const children = await prisma.chat.findMany({
    where: { userId: req.userId!, path: { startsWith: `${chat.path}/` } },
  });

  res.json(children.map((c) => ({ chatId: c.chatId, path: c.path, messages: asMessages(c.messages) })));
}

// DELETE /:chatid - delete this chat and every fork descending from it
export async function deleteChat(req: Request<{ chatid: string }>, res: Response) {
  const chat = await findOwnedChat(req.params.chatid!, req.userId!);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }

  await prisma.chat.deleteMany({
    where: {
      userId: req.userId!,
      OR: [{ chatId: chat.chatId }, { path: { startsWith: `${chat.path}/` } }],
    },
  });

  res.status(204).send();
}
