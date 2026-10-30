import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../auth/passwords.js";
import { issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  revokeSession,
} from "../auth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  merchantId?: string;
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
}

/**
 * Merchant login is two-step: POST /login checks merchantId+email+password
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** POST /v1/auth/login — step 1. */
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { merchantId, email, password } = request.body ?? {};
    if (!merchantId || !email || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }

    const userResult = await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
      [merchantId, email],
    );
    const user = userResult.rows[0];

    // timing-safe: hashes against a dummy when the user is missing. correct — FH
    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    // Fix 1.4: send the OTP to exactly the user whose password was just checked.
    // Before, it looked the user up again by EMAIL ONLY. The same email can
    // exist under several merchants, so the code (and the session) could end
    // up belonging to a different merchant's account.
    // إصلاح 1.4: نرسل الكود لنفس المستخدم اللي تأكدنا من الباسوورد حقه.
    // قبل كان يدوّر عليه مرة ثانية بالإيميل بس، ونفس الإيميل ممكن يكون عند
    // أكثر من تاجر، فالكود (والجلسة) ممكن يروحون لحساب تاجر ثاني.
    const recipient = user;

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);

    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }

      const challengeResult = await app.db.query<{
        id: string;
        code_salt: string;
        code_hash: string;
        attempt_count: number;
        max_attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, code_salt, code_hash, attempt_count, max_attempts, expires_at, consumed_at
           FROM otp_challenges WHERE id = $1`,
        [pending.otpChallengeId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at !== null) {
        throw new GoneError("otp_expired");
      }
      if (challenge.expires_at.getTime() <= Date.now()) {
        throw new GoneError("otp_expired");
      }

      // Fix 1.3: spend one attempt FIRST, in a single atomic UPDATE, and only
      // then compare the code. Before, it read attempt_count, compared, and
      // increased it later. 50 parallel requests all read attempt_count = 0,
      // so each got a free guess (50 guesses instead of 5).
      // Now the database itself refuses once attempt_count reaches max_attempts.
      // إصلاح 1.3: نحسب المحاولة أول (بأمر UPDATE واحد ما ينقسم)، وبعدين
      // نقارن الكود. قبل كان يقرا العداد، ويقارن، وبعدين يزيده. لو انرسل
      // 50 طلب بنفس اللحظة، كلهم يقرون 0 ويجربون (50 تخمين بدل 5).
      // الحين قاعدة البيانات نفسها ترفض لما يوصل العداد للحد.
      const spent = await app.db.query(
        `UPDATE otp_challenges SET attempt_count = attempt_count + 1
          WHERE id = $1 AND attempt_count < max_attempts AND consumed_at IS NULL
          RETURNING attempt_count`,
        [challenge.id],
      );
      if (spent.rowCount === 0) {
        // No attempts left: kill the pending session.
        // ما باقي محاولات: نلغي الجلسة المؤقتة.
        await revokeSession(app.db, pending.sessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }

      const matches = verifyOtpCode(code, challenge.code_salt, challenge.code_hash);
      if (!matches) {
        // The attempt was already counted above.
        // المحاولة انحسبت فوق خلاص.
        throw new UnauthorizedError("invalid_code");
      }

      const merchantUserResult = await withTransaction(app.db, async (client) => {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challenge.id]);
        // promoteSession bumps expires_at to 12h server-side; the cookie maxAge doesn't matter because
        // MK: admin verify re-sets the cookie after this, merchant verify doesnt. related to the 10 min logouts?
        await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        return result.rows[0];
      });
      if (!merchantUserResult) {
        throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
      }

      // Fix 3.6: re-issue the cookie with the full session lifetime (12h), the
      // same way the admin login does. Before, the browser kept the short
      // pending-session cookie (10 min), so merchants got logged out after 10 min.
      // إصلاح 3.6: نرجع نحط الكوكي بعمر الجلسة الكامل (12 ساعة) مثل دخول
      // الأدمن. قبل، المتصفح يحتفظ بكوكي الجلسة المؤقتة (10 دقايق)، فالتاجر
      // يطلع من حسابه بعد 10 دقايق.
      reply.setCookie(app.config.cookieName, rawToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: app.config.sessionTtlHours * 3_600,
      });

      reply.code(200).send({
        authenticated: true,
        merchantId: merchantUserResult.merchant_id,
        role: merchantUserResult.role,
      });
    },
  );

  /**
   * Re-issues the OTP for a pending session. Throttled to one per 30s. The
   * new challenge inherits the previous challenge's attempt_count so a
   * resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = request.cookies[app.config.cookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }

    const existing = await app.db.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM otp_challenges WHERE id = $1`,
      [pending.otpChallengeId],
    );
    const existingChallenge = existing.rows[0];
    if (existingChallenge && Date.now() - existingChallenge.created_at.getTime() < 30_000) {
      throw new TooManyRequestsError("resend_too_soon");
    }

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      if (existingChallenge) {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [
          existingChallenge.id,
        ]);
      }
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      await client.query(`UPDATE sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.sessionId,
      ]);
      return challenge;
    });

    const userResult = await app.db.query<{ email: string }>(
      `SELECT email FROM merchant_users WHERE id = $1`,
      [pending.merchantUserId],
    );
    sendOtpCode(
      request.log,
      app.config,
      { merchantUserId: pending.merchantUserId, email: userResult.rows[0]?.email ?? "" },
      code,
    );

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.get(
    "/me",
    { preHandler: requireSession },
    async (request: FastifyRequest) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      const result = await app.db.query<{
        email: string;
        merchant_id: string;
        display_name: string;
        onboarding_status: string;
      }>(
        `SELECT mu.email, m.id AS merchant_id, m.display_name, m.onboarding_status
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.id = $1`,
        [auth.merchantUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedError("unauthenticated");
      }
      return {
        merchantUserId: auth.merchantUserId,
        email: row.email,
        role: auth.role,
        merchant: {
          id: row.merchant_id,
          displayName: row.display_name,
          onboardingStatus: row.onboarding_status,
        },
      };
    },
  );

  app.post(
    "/logout",
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeSession(app.db, auth.sessionId);
      reply.setCookie(app.config.cookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}