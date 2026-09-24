-- CreateTable
CREATE TABLE "chats" (
    "userId" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "messages" JSONB NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE INDEX "chats_userId_idx" ON "chats"("userId");
