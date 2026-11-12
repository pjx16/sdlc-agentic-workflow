-- CreateTable
CREATE TABLE "WorkerStatus" (
    "id" TEXT NOT NULL DEFAULT 'worker',
    "heartbeatAt" TIMESTAMPTZ(6) NOT NULL,
    "tickOutcome" TEXT NOT NULL,
    "tickDetail" TEXT,
    "intakeMode" TEXT,
    "intakeAt" TIMESTAMPTZ(6),
    "intakeProjects" INTEGER NOT NULL DEFAULT 0,
    "intakeWaiting" INTEGER NOT NULL DEFAULT 0,
    "intakeCreated" INTEGER NOT NULL DEFAULT 0,
    "intakeSeen" INTEGER NOT NULL DEFAULT 0,
    "intakeError" TEXT,
    "intakeSkipped" TEXT,

    CONSTRAINT "WorkerStatus_pkey" PRIMARY KEY ("id")
);
