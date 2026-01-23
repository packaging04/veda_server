/**
 * Security Helpers
 * SSRF protection, PII sanitization, etc.
 */

import { ENV } from "../config/env.ts";

export function validateRecordingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ENV.AT_ALLOWED_DOMAINS.some((domain) =>
      parsed.hostname.endsWith(domain),
    );
  } catch {
    return false;
  }
}

export function sanitizePhoneNumber(phone: string): string {
  return phone.replace(/[^\d+]/g, "").substring(0, 20);
}

export function hashPii(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data.charCodeAt(i);
    hash = hash & hash;
  }
  return `***${Math.abs(hash).toString(16)}`;
}
