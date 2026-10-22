// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aliyun SMS (短信服务) adapter.
 *
 * ## Why an adapter and not the SDK
 *
 * The kit's transport contract asks for one method and no vendor vocabulary in
 * the result. The official SDK would add a dependency, an exception hierarchy
 * whose `message` embeds the destination number, and a second retry policy on
 * top of the send budget this server already charges. The RPC signature is
 * small and stable, so it is implemented here against `fetch`.
 *
 * ## What this file guarantees
 *
 * - The result is one of the kit's failure codes. The provider's `Message` —
 *   which routinely echoes the number and sometimes the template parameter —
 *   is never read into a result, never logged and never attached to an error.
 * - No retry. The kit charged the send budget before calling; a silent retry
 *   would spend money outside that budget and outside the audit.
 * - The destination is converted to the national form Aliyun expects
 *   (`13800138000`), because a `+86` prefix is rejected as an illegal number.
 * - A timeout turns into `TRANSPORT_UNAVAILABLE`, so the service rolls the
 *   pending challenge back instead of leaving a live code nobody received.
 *
 * ## Signature
 *
 * Aliyun's RPC style: percent-encode (RFC 3986) every parameter, sort by name,
 * join as `k=v&k=v`, sign `POST&%2F&<encoded canonical query>` with
 * HMAC-SHA1 keyed by `<AccessKeySecret>&`, base64 the digest. The signature is
 * then appended to the form body. This is the documented algorithm, not an
 * interpretation of one.
 */

import { createHmac, randomUUID } from "node:crypto";
import type {
  SmsFailureCode,
  SmsSendRequest,
  SmsSendResult,
  SmsTransport,
} from "../../../../modules/phone-otp-kit/src/otp/sms.js";
import type { SmsLogger } from "./transport.js";

export const ALIYUN_SMS_ENDPOINT = "https://dysmsapi.aliyuncs.com/";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AliyunSmsOptions {
  accessKeyId: string;
  accessKeySecret: string;
  /** Approved sign name, e.g. KoBook. */
  signName: string;
  /** Approved template code, e.g. SMS_123456789. */
  templateCode: string;
  region: string;
  /** Override for tests. Defaults to {@link ALIYUN_SMS_ENDPOINT}. */
  endpoint?: string;
  /** Injected fetch for tests; defaults to the global one. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The provider's error codes, folded into the kit's allowlist.
 *
 * Anything not listed degrades to `UNKNOWN` rather than being echoed: a code
 * this file has never seen is exactly the case where the provider's text might
 * contain something that must not be logged.
 */
const RATE_LIMITED_CODES = new Set([
  "isv.BUSINESS_LIMIT_CONTROL",
  "isv.DAY_LIMIT_CONTROL",
  "isv.MONTH_LIMIT_CONTROL",
  "isv.OUT_OF_SERVICE",
]);

const INVALID_DESTINATION_CODES = new Set([
  "isv.MOBILE_NUMBER_ILLEGAL",
  "isv.MOBILE_COUNT_OVER_LIMIT",
]);

const REJECTED_CODES = new Set([
  "isv.SMS_TEMPLATE_ILLEGAL",
  "isv.SMS_SIGNATURE_ILLEGAL",
  "isv.TEMPLATE_MISSING_PARAMETERS",
  "isv.SMS_CONTENT_ILLEGAL",
  "isv.AMOUNT_NOT_ENOUGH",
  "isv.PRODUCT_UN_SUBSCRIPT",
  "isv.INVALID_PARAMETERS",
  "isp.RAM_PERMISSION_DENY",
  "isp.SYSTEM_ERROR",
  // Deployment/credential mistakes. The provider answers these with a
  // provider-level `Code`, sometimes under a non-2xx status (a bad AccessKey
  // comes back as HTTP 404 with a JSON body), which is why the response body
  // is inspected before the status is judged.
  "InvalidAccessKeyId.NotFound",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "InvalidTimeStamp.Expired",
  "Forbidden.RAM",
  "Forbidden",
]);

export function classifyAliyunCode(code: string): SmsFailureCode {
  if (RATE_LIMITED_CODES.has(code)) return "RATE_LIMITED";
  if (INVALID_DESTINATION_CODES.has(code)) return "INVALID_DESTINATION";
  if (REJECTED_CODES.has(code)) return "REJECTED";
  return "UNKNOWN";
}

/** RFC 3986 percent-encoding, as the RPC signature requires. */
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Aliyun accepts the national number, not E.164. */
export function toNationalNumber(e164: string): string {
  return e164.startsWith("+86") ? e164.slice(3) : e164.replace(/^\+/u, "");
}

export function signAliyunRequest(
  parameters: Record<string, string>,
  accessKeySecret: string,
): string {
  const canonical = Object.keys(parameters)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(parameters[key] ?? "")}`)
    .join("&");
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonical)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
}

export interface AliyunSmsTransport extends SmsTransport {
  readonly kind: "aliyun";
  attachLogger(log: SmsLogger): void;
}

export function createAliyunSmsTransport(options: AliyunSmsOptions): AliyunSmsTransport {
  const endpoint = options.endpoint ?? ALIYUN_SMS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let logger: SmsLogger | undefined;

  return {
    kind: "aliyun",

    attachLogger(log: SmsLogger): void {
      logger = log;
    },

    async send(request: SmsSendRequest): Promise<SmsSendResult> {
      const parameters: Record<string, string> = {
        AccessKeyId: options.accessKeyId,
        Action: "SendSms",
        Format: "JSON",
        PhoneNumbers: toNationalNumber(request.toE164),
        RegionId: options.region,
        SignName: options.signName,
        SignatureMethod: "HMAC-SHA1",
        SignatureNonce: randomUUID(),
        SignatureVersion: "1.0",
        TemplateCode: options.templateCode,
        TemplateParam: JSON.stringify({ code: request.code }),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
        Version: "2017-05-25",
      };

      const signature = signAliyunRequest(parameters, options.accessKeySecret);
      const body = new URLSearchParams({ ...parameters, Signature: signature }).toString();

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // DNS failure, TLS failure, timeout: classified, never described.
        logger?.error({ purpose: request.purpose, failure: "TRANSPORT_UNAVAILABLE" }, "SMS send failed");
        return { ok: false, failure: "TRANSPORT_UNAVAILABLE" };
      }

      // The body is read before the status is judged. Aliyun reports a bad
      // AccessKey as HTTP 404 and an invalid template as HTTP 400, both with a
      // JSON `Code` — so trusting `response.ok` alone would classify a
      // credential mistake as a generic transport failure and send the
      // operator looking at the network.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }

      const providerCode =
        typeof payload === "object" && payload !== null && typeof (payload as { Code?: unknown }).Code === "string"
          ? (payload as { Code: string }).Code
          : "";

      if (response.ok && providerCode === "OK") {
        logger?.debug({ purpose: request.purpose }, "SMS accepted by provider");
        return { ok: true };
      }

      const failure: SmsFailureCode =
        providerCode !== ""
          ? classifyAliyunCode(providerCode)
          : response.status === 429
            ? "RATE_LIMITED"
            : response.status >= 500 || payload === undefined
              ? "TRANSPORT_UNAVAILABLE"
              : "UNKNOWN";

      logger?.error({ purpose: request.purpose, failure, status: response.status }, "SMS send failed");
      return { ok: false, failure };
    },
  };
}

