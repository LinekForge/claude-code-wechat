/**
 * Unit tests for pure functions.
 * Run with: bun test
 */

import { describe, test, expect } from "bun:test";
import crypto from "node:crypto";

// ── parseAesKey ──────────────────────────────────────────────────────────────

// Import from media.ts
import { parseAesKey, encryptAesEcb, decryptAes128Ecb, aesEcbPaddedSize, detectImageExt, getMimeType } from "./media.js";

describe("parseAesKey", () => {
  test("parses raw hex key (32 chars)", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    const key = parseAesKey(hex);
    expect(key.length).toBe(16);
    expect(key.toString("hex")).toBe(hex);
  });

  test("parses base64-encoded hex key", () => {
    const hex = "c8c246f21673725b07605b2cab9426ac";
    const b64 = Buffer.from(hex).toString("base64");
    const key = parseAesKey(b64);
    expect(key.length).toBe(16);
    expect(key.toString("hex")).toBe(hex);
  });

  test("parses raw binary base64 key", () => {
    const rawKey = crypto.randomBytes(16);
    const b64 = rawKey.toString("base64");
    // Only works if the decoded bytes don't look like a hex string
    // Use a key that contains non-hex bytes when decoded as utf-8
    const nonHexKey = Buffer.from([0xff, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e]);
    const nonHexB64 = nonHexKey.toString("base64");
    const parsed = parseAesKey(nonHexB64);
    expect(parsed.length).toBe(16);
  });
});

// ── AES encrypt/decrypt symmetry ─────────────────────────────────────────────

describe("AES-128-ECB encrypt/decrypt", () => {
  test("decrypt(encrypt(data)) returns original data", () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from("hello world, this is a test message for AES encryption");
    const encrypted = encryptAesEcb(plaintext, key);
    const decrypted = decryptAes128Ecb(encrypted, key);
    expect(decrypted.toString()).toBe(plaintext.toString());
  });

  test("works with empty-ish data (single byte)", () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from("x");
    const encrypted = encryptAesEcb(plaintext, key);
    const decrypted = decryptAes128Ecb(encrypted, key);
    expect(decrypted.toString()).toBe("x");
  });

  test("works with data exactly 16 bytes", () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from("1234567890123456");
    const encrypted = encryptAesEcb(plaintext, key);
    const decrypted = decryptAes128Ecb(encrypted, key);
    expect(decrypted.toString()).toBe("1234567890123456");
  });
});

// ── aesEcbPaddedSize ─────────────────────────────────────────────────────────

describe("aesEcbPaddedSize", () => {
  test("1 byte → 16 bytes", () => {
    expect(aesEcbPaddedSize(1)).toBe(16);
  });

  test("15 bytes → 16 bytes", () => {
    expect(aesEcbPaddedSize(15)).toBe(16);
  });

  test("16 bytes → 32 bytes (PKCS7 adds full block)", () => {
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  test("17 bytes → 32 bytes", () => {
    expect(aesEcbPaddedSize(17)).toBe(32);
  });

  test("0 bytes → 16 bytes", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
  });
});

// ── detectImageExt ───────────────────────────────────────────────────────────

describe("detectImageExt", () => {
  test("JPEG magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageExt(buf)).toBe("jpg");
  });

  test("PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(detectImageExt(buf)).toBe("png");
  });

  test("GIF magic bytes", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageExt(buf)).toBe("gif");
  });

  test("WebP magic bytes", () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
    expect(detectImageExt(buf)).toBe("webp");
  });

  test("unknown format defaults to jpg", () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(detectImageExt(buf)).toBe("jpg");
  });
});

// ── getMimeType ──────────────────────────────────────────────────────────────

describe("getMimeType", () => {
  test("jpg", () => expect(getMimeType("photo.jpg")).toBe("image/jpeg"));
  test("jpeg", () => expect(getMimeType("photo.jpeg")).toBe("image/jpeg"));
  test("png", () => expect(getMimeType("icon.png")).toBe("image/png"));
  test("mp4", () => expect(getMimeType("video.mp4")).toBe("video/mp4"));
  test("pdf", () => expect(getMimeType("doc.pdf")).toBe("application/pdf"));
  test("unknown", () => expect(getMimeType("file.xyz")).toBe("application/octet-stream"));
  test("case insensitive path", () => expect(getMimeType("/path/to/PHOTO.JPG")).toBe("image/jpeg"));
});

// ── migrateAllowlist ─────────────────────────────────────────────────────────

import { migrateAllowlist } from "./allowlist.js";

describe("migrateAllowlist", () => {
  test("migrates old string[] format", () => {
    const old = { allowed: ["abc@im.wechat", "def@im.wechat"], auto_allow_next: false };
    const result = migrateAllowlist(old);
    expect(result.allowed.length).toBe(2);
    expect(result.allowed[0].id).toBe("abc@im.wechat");
    expect(result.allowed[0].nickname).toBe("abc");
    expect(result.allowed[1].id).toBe("def@im.wechat");
  });

  test("keeps new AllowEntry[] format unchanged", () => {
    const current = {
      allowed: [{ id: "abc@im.wechat", nickname: "Alice" }],
      auto_allow_next: true,
    };
    const result = migrateAllowlist(current);
    expect(result.allowed[0].nickname).toBe("Alice");
    expect(result.auto_allow_next).toBe(true);
  });

  test("handles null/undefined input", () => {
    expect(migrateAllowlist(null).allowed.length).toBe(0);
    expect(migrateAllowlist(undefined).allowed.length).toBe(0);
    expect(migrateAllowlist({}).allowed.length).toBe(0);
  });
});

// ── generateDailySchedule ────────────────────────────────────────────────────

import { generateDailySchedule } from "./heartbeat.js";

describe("generateDailySchedule", () => {
  test("includes fixed entries", () => {
    const config = {
      fixed: [{ hour: 9, minute: 0, label: "morning" }],
      random: { active_start: 9, active_end: 22, daily_count: 5, min_per_hour: 0 },
    };
    const schedule = generateDailySchedule(config);
    const fixed = schedule.filter((e) => e.type === "fixed");
    expect(fixed.length).toBe(1);
    expect(fixed[0].hour).toBe(9);
    expect(fixed[0].label).toBe("morning");
  });

  test("respects daily_count", () => {
    const config = {
      fixed: [],
      random: { active_start: 9, active_end: 22, daily_count: 10, min_per_hour: 0 },
    };
    const schedule = generateDailySchedule(config);
    expect(schedule.length).toBe(10);
  });

  test("handles daily_count < totalHours * min_per_hour (no negative remaining)", () => {
    const config = {
      fixed: [],
      random: { active_start: 9, active_end: 22, daily_count: 3, min_per_hour: 1 },
    };
    const schedule = generateDailySchedule(config);
    // Should have at most 13 (one per hour), not crash from negative remaining
    expect(schedule.length).toBeGreaterThanOrEqual(3);
  });

  test("sorted by time", () => {
    const config = {
      fixed: [{ hour: 22, minute: 0 }, { hour: 9, minute: 0 }],
      random: { active_start: 9, active_end: 22, daily_count: 5, min_per_hour: 0 },
    };
    const schedule = generateDailySchedule(config);
    for (let i = 1; i < schedule.length; i++) {
      const prev = schedule[i - 1].hour * 60 + schedule[i - 1].minute;
      const curr = schedule[i].hour * 60 + schedule[i].minute;
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});
