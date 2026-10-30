import { isIP } from "node:net";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
// Fix 1.11 (SSRF): a merchant chooses the webhook URL, and OUR server calls it.
// Before, any https URL was accepted, including our own internal addresses
// (localhost, 10.x, 192.168.x, the cloud metadata service 169.254.169.254,
// Docker names like "postgres"). So a merchant could make our server attack
// or read our own internal network.
// إصلاح 1.11 (SSRF): التاجر يختار رابط الـ webhook، وسيرفرنا هو اللي يتصل فيه.
// قبل، أي رابط https ينقبل، حتى عناويننا الداخلية (localhost، 10.x،
// 192.168.x، خدمة بيانات السحابة 169.254.169.254، وأسماء Docker مثل
// "postgres")، فالتاجر يقدر يخلي سيرفرنا يهاجم أو يقرا شبكتنا الداخلية.

/** True for loopback, private, link-local (incl. cloud metadata
 *  169.254.169.254), CGNAT and unspecified addresses. */
// Returns true if the host is an internal/private address.
// ترجع true إذا العنوان داخلي أو خاص.
function isInternalAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  const family = isIP(h);
  if (family === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") ||
      h.startsWith("::ffff:");
  }
  return false;
}

// https-only alone is NOT SSRF protection: https://169.254.169.254/ or an
// internal https host would still be called by the dispatcher. In
// production, internal hosts are refused here and redirects are not
// followed (transport.ts). Single-label hostnames (e.g. "settlement",
// "postgres") are Docker-internal service names, also refused.
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production") {
    if (parsed.protocol !== "https:") {
      throw new BadRequestError("invalid_url");
    }
    const host = parsed.hostname;
    // Fix 1.11: refuse internal addresses and single-word Docker names (no dot).
    // إصلاح 1.11: نرفض العناوين الداخلية وأسماء Docker اللي كلمة وحدة (بدون نقطة).
    if (isInternalAddress(host) || (isIP(host) === 0 && !host.includes("."))) {
      throw new BadRequestError("invalid_url", "webhook URL must be a public host");
    }
  }
  return parsed;
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}