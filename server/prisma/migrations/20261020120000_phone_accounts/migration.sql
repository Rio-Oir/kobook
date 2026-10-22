-- Phone-number accounts.
--
-- `user.email` stays NOT NULL UNIQUE: the auth core keys its credential and
-- verification rows on it, and making it nullable would push a second identity
-- model into every read. A phone account instead receives a placeholder address
-- in the reserved `@phone.invalid` domain (unroutable, and refused by the
-- sign-up hook so nobody can claim a number's placeholder through the email
-- form). `emailVerified` is set when the account is created from a verified
-- number: the SMS code is the ownership proof.
ALTER TABLE "user" ADD COLUMN "phoneNumber" TEXT;
ALTER TABLE "user" ADD COLUMN "phoneNumberVerified" BOOLEAN NOT NULL DEFAULT false;

-- Postgres allows several NULLs under a unique index, so email accounts are
-- unaffected while a number can back at most one account.
CREATE UNIQUE INDEX "user_phoneNumber_key" ON "user"("phoneNumber");

-- Phone verification challenges, backing the kit's OtpChallengeStore contract.
--
-- No plaintext phone number and no plaintext code: `phoneRef` and `codeHash`
-- are HMAC digests produced by the kit. `generation` is a sequence, so a
-- revoke/activate can be conditional on the reservation it was handed instead
-- of on a reusable id.
CREATE TABLE "phone_otp_challenge" (
    "id" TEXT NOT NULL,
    "generation" SERIAL NOT NULL,
    "purpose" TEXT NOT NULL,
    "phoneRef" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL,

    CONSTRAINT "phone_otp_challenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "phone_otp_challenge_generation_key" ON "phone_otp_challenge"("generation");
CREATE INDEX "phone_otp_challenge_purpose_phoneRef_state_idx" ON "phone_otp_challenge"("purpose", "phoneRef", "state");
CREATE INDEX "phone_otp_challenge_expiresAt_idx" ON "phone_otp_challenge"("expiresAt");
