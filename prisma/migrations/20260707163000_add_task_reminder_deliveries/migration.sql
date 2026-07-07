-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('TELEGRAM');

-- CreateTable
CREATE TABLE "TaskReminderDelivery" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'TELEGRAM',
    "dueDateSnapshot" TIMESTAMP(3) NOT NULL,
    "effectiveReminderMinutesBefore" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskReminderDelivery_taskId_userId_dueDateSnapshot_channel_key" ON "TaskReminderDelivery"("taskId", "userId", "dueDateSnapshot", "channel");

-- CreateIndex
CREATE INDEX "TaskReminderDelivery_sentAt_scheduledFor_idx" ON "TaskReminderDelivery"("sentAt", "scheduledFor");

-- CreateIndex
CREATE INDEX "TaskReminderDelivery_taskId_userId_idx" ON "TaskReminderDelivery"("taskId", "userId");

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill legacy deliveries for already-sent personal tasks
INSERT INTO "TaskReminderDelivery" (
    "id",
    "taskId",
    "userId",
    "channel",
    "dueDateSnapshot",
    "effectiveReminderMinutesBefore",
    "scheduledFor",
    "attemptCount",
    "lastAttemptAt",
    "sentAt",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('legacy:', t."id", ':', u."id", ':personal'),
    t."id",
    u."id",
    'TELEGRAM'::"ReminderChannel",
    t."dueDate",
    COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30),
    t."dueDate" - make_interval(mins => COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30)),
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Task" t
JOIN "User" u ON u."id" = COALESCE(t."assignedToUserId", t."createdByUserId")
LEFT JOIN "Settings" s ON s."familyId" = t."familyId"
WHERE
    t."reminderSent" = true
    AND t."dueDate" IS NOT NULL
    AND t."scope" = 'PERSONAL'
ON CONFLICT ("taskId", "userId", "dueDateSnapshot", "channel") DO NOTHING;

-- Backfill legacy deliveries for already-sent assigned family tasks
INSERT INTO "TaskReminderDelivery" (
    "id",
    "taskId",
    "userId",
    "channel",
    "dueDateSnapshot",
    "effectiveReminderMinutesBefore",
    "scheduledFor",
    "attemptCount",
    "lastAttemptAt",
    "sentAt",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('legacy:', t."id", ':', u."id", ':family-assigned'),
    t."id",
    u."id",
    'TELEGRAM'::"ReminderChannel",
    t."dueDate",
    COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30),
    t."dueDate" - make_interval(mins => COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30)),
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Task" t
LEFT JOIN "Settings" s ON s."familyId" = t."familyId"
JOIN "User" u ON u."id" IN (t."createdByUserId", t."assignedToUserId")
WHERE
    t."reminderSent" = true
    AND t."dueDate" IS NOT NULL
    AND t."scope" = 'FAMILY'
    AND t."assignedToUserId" IS NOT NULL
ON CONFLICT ("taskId", "userId", "dueDateSnapshot", "channel") DO NOTHING;

-- Backfill legacy deliveries for already-sent unassigned family tasks
INSERT INTO "TaskReminderDelivery" (
    "id",
    "taskId",
    "userId",
    "channel",
    "dueDateSnapshot",
    "effectiveReminderMinutesBefore",
    "scheduledFor",
    "attemptCount",
    "lastAttemptAt",
    "sentAt",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('legacy:', t."id", ':', u."id", ':family-unassigned'),
    t."id",
    u."id",
    'TELEGRAM'::"ReminderChannel",
    t."dueDate",
    COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30),
    t."dueDate" - make_interval(mins => COALESCE(t."reminderMinutesBefore", u."reminderMinutesBefore", s."reminderMinutesBefore", 30)),
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Task" t
LEFT JOIN "Settings" s ON s."familyId" = t."familyId"
JOIN "User" u ON u."familyId" = t."familyId"
WHERE
    t."reminderSent" = true
    AND t."dueDate" IS NOT NULL
    AND t."scope" = 'FAMILY'
    AND t."assignedToUserId" IS NULL
    AND u."isActive" = true
    AND u."telegramChatId" IS NOT NULL
ON CONFLICT ("taskId", "userId", "dueDateSnapshot", "channel") DO NOTHING;
