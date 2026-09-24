import { Router } from 'express';
import {
  listModels,
  createChat,
  getChat,
  forkChat,
  sendMessage,
  listTopLevelChats,
  listChildren,
  deleteChat,
} from './chats.controller.js';

export const chatsRouter = Router();

// Must stay above `GET /:chatid`, which would otherwise swallow `/models`.
chatsRouter.get('/models', listModels);
chatsRouter.post('/chats', createChat);
chatsRouter.get('/:chatid', getChat);
chatsRouter.post('/fork/:chatid', forkChat);
chatsRouter.post('/message/:chatid', sendMessage);
chatsRouter.get('/chats/:userid', listTopLevelChats);
chatsRouter.get('/children/:chatid', listChildren);
chatsRouter.delete('/:chatid', deleteChat);
