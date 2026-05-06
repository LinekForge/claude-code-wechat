/**
 * Allowlist management: who is allowed to message the bot.
 */

import fs from "node:fs";
import path from "node:path";

import { ALLOW_FILE, log } from "./config.js";
import type { AllowEntry, Allowlist } from "./types.js";

// Migration: convert old string[] format to new AllowEntry[] format
export function migrateAllowlist(raw: any): Allowlist {
  if (!raw || !raw.allowed) return { allowed: [], auto_allow_next: false };
  const allowed: AllowEntry[] = raw.allowed.map((entry: any) => {
    if (typeof entry === "string") {
      return { id: entry, nickname: entry.split("@")[0] };
    }
    return entry as AllowEntry;
  });
  return { allowed, auto_allow_next: raw.auto_allow_next ?? false };
}

export function loadAllowlist(): Allowlist {
  try {
    if (fs.existsSync(ALLOW_FILE)) {
      return migrateAllowlist(JSON.parse(fs.readFileSync(ALLOW_FILE, "utf-8")));
    }
  } catch {}
  return { allowed: [], auto_allow_next: false };
}

export function saveAllowlist(list: Allowlist): void {
  fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
  fs.writeFileSync(ALLOW_FILE, JSON.stringify(list, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function isAllowed(senderId: string): boolean {
  const list = loadAllowlist();

  if (list.allowed.some((e) => e.id === senderId)) return true;

  if (list.auto_allow_next) {
    list.allowed.push({ id: senderId, nickname: senderId.split("@")[0] });
    list.auto_allow_next = false;
    saveAllowlist(list);
    log(`✅ 自动添加到 allowlist: ${senderId}`);
    return true;
  }

  return false;
}

export function getNickname(senderId: string): string {
  const list = loadAllowlist();
  const entry = list.allowed.find((e) => e.id === senderId);
  return entry?.nickname || senderId.split("@")[0];
}
