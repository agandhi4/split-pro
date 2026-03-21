/*
  Warnings:

  - A unique constraint covering the columns `[userId,accessToken]` on the table `BankConnection` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_userId_accessToken_key" ON "BankConnection"("userId", "accessToken");
