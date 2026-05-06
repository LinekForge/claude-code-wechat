#!/usr/bin/env bun
/**
 * WeChat Channel Setup
 *
 * Usage:
 *   bun setup.ts                    — 扫码登录微信
 *   bun setup.ts --allow ID [昵称]  — 添加 sender 到 allowlist（可选昵称）
 *   bun setup.ts --nick ID 昵称     — 修改已有 sender 的昵称
 *   bun setup.ts --list             — 查看 allowlist
 *   bun setup.ts --allow-all        — 首次收到消息时自动添加（方便调试）
 */

import fs from "node:fs";

import { DIR, CRED_FILE } from "./config.js";
import { loadAllowlist, saveAllowlist } from "./allowlist.js";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";

// ── CLI subcommands ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--allow" && args[1]) {
  const list = loadAllowlist();
  const id = args[1];
  const nickname = args[2] || id.split("@")[0];
  const existing = list.allowed.find((e) => e.id === id);
  if (!existing) {
    list.allowed.push({ id, nickname });
    saveAllowlist(list);
    console.log(`✅ 已添加到 allowlist: ${nickname} (${id})`);
  } else {
    if (args[2]) {
      existing.nickname = args[2];
      saveAllowlist(list);
      console.log(`✅ 已更新昵称: ${existing.nickname} (${id})`);
    } else {
      console.log(`已在 allowlist 中: ${existing.nickname} (${id})`);
    }
  }
  process.exit(0);
}

if (args[0] === "--nick" && args[1] && args[2]) {
  const list = loadAllowlist();
  const entry = list.allowed.find((e) => e.id === args[1]);
  if (entry) {
    entry.nickname = args[2];
    saveAllowlist(list);
    console.log(`✅ 昵称已更新: ${entry.nickname} (${entry.id})`);
  } else {
    console.log(`未找到 ID: ${args[1]}`);
  }
  process.exit(0);
}

if (args[0] === "--allow-all") {
  const list = loadAllowlist();
  list.auto_allow_next = true;
  saveAllowlist(list);
  console.log("✅ 已开启自动添加模式：下一个发消息的 sender 将自动加入 allowlist");
  process.exit(0);
}

if (args[0] === "--list") {
  const list = loadAllowlist();
  if (list.allowed.length === 0) {
    console.log("allowlist 为空。");
    console.log("使用 bun setup.ts --allow-all 开启自动添加，然后从微信发一条消息。");
  } else {
    console.log("当前 allowlist:");
    for (const entry of list.allowed) {
      console.log(`  - ${entry.nickname} (${entry.id})`);
    }
  }
  if (list.auto_allow_next) {
    console.log("\n[自动添加模式已开启]");
  }
  process.exit(0);
}

// ── QR Login ─────────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(): Promise<QRCodeResponse> {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`获取微信登录二维码失败：HTTP ${res.status}。下一步：确认网络能访问 ${BASE_URL}，然后在仓库目录重新运行 bun cli.ts setup。`);
  }
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(qrcode: string): Promise<QRStatusResponse> {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`检查二维码扫码状态失败：HTTP ${res.status}。下一步：保持终端打开并重试；如果持续失败，在仓库目录重新运行 bun cli.ts setup。`);
    }
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

// ── Main: QR login flow ──────────────────────────────────────────────────────

if (fs.existsSync(CRED_FILE)) {
  try {
    const existing = JSON.parse(fs.readFileSync(CRED_FILE, "utf-8"));
    console.log(`已有保存的账号: ${existing.accountId}`);
    console.log(`保存时间: ${existing.savedAt}`);
    console.log();
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("是否重新登录？(y/N) ", resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== "y") {
      console.log("保持现有凭据，退出。");
      process.exit(0);
    }
  } catch {}
}

console.log("正在获取微信登录二维码...\n");
const qrResp = await fetchQRCode();

try {
  const qrterm = await import("qrcode-terminal");
  await new Promise<void>((resolve) => {
    qrterm.default.generate(
      qrResp.qrcode_img_content,
      { small: true },
      (qr: string) => {
        console.log(qr);
        resolve();
      },
    );
  });
} catch {
  console.log(`请在浏览器中打开此链接扫码: ${qrResp.qrcode_img_content}\n`);
}

console.log("请用微信扫描上方二维码...\n");

const deadline = Date.now() + 480_000;
let scannedPrinted = false;

while (Date.now() < deadline) {
  const status = await pollQRStatus(qrResp.qrcode);

  switch (status.status) {
    case "wait":
      process.stdout.write(".");
      break;
    case "scaned":
      if (!scannedPrinted) {
        console.log("\n已扫码，请在微信中确认...");
        scannedPrinted = true;
      }
      break;
    case "expired":
      console.log("\n二维码已过期。下一步：在仓库目录重新运行 bun cli.ts setup，并让用户重新扫码。");
      process.exit(1);
      break;
    case "confirmed": {
      if (!status.ilink_bot_id || !status.bot_token) {
        console.error("\n登录失败：微信服务器未返回完整账号信息。下一步：在仓库目录重新运行 bun cli.ts setup；如果持续失败，检查 ClawBot/iLink 是否可用。");
        process.exit(1);
      }

      const account = {
        token: status.bot_token,
        baseUrl: status.baseurl || BASE_URL,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };

      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(CRED_FILE, JSON.stringify(account, null, 2), { encoding: "utf-8", mode: 0o600 });

      console.log(`\n✅ 微信连接成功！`);
      console.log(`   账号 ID: ${account.accountId}`);
      console.log(`   凭据保存至: ${CRED_FILE}`);
      console.log();
      console.log("下一步：");
      console.log("  1. 在目标项目目录运行 bun /path/to/claude-code-wechat/cli.ts install");
      console.log("  2. 运行 bun /path/to/claude-code-wechat/cli.ts doctor 检查状态");
      console.log("  3. 启动 claude --dangerously-load-development-channels server:wechat");
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\n登录超时。下一步：在仓库目录重新运行 bun cli.ts setup，并在 8 分钟内完成扫码和微信确认。");
process.exit(1);
