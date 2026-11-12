-- CreateTable
CREATE TABLE "Credential" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL,
    "hint" TEXT,
    "verifiedAt" TIMESTAMPTZ(6),
    "verifyError" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminAccount" (
    "id" TEXT NOT NULL DEFAULT 'admin',
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AdminAccount_pkey" PRIMARY KEY ("id")
);
