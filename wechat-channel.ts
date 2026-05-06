#!/usr/bin/env bun
/**
 * WeChat Channel for Claude Code
 *
 * Bridges WeChat messages into a Claude Code session via Channels MCP protocol.
 * Uses the official WeChat ClawBot ilink API (ilinkai.weixin.qq.com).
 */

import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ── Module Imports ───────────────────────────────────────────────────────────

import {
  CHANNEL_NAME,
  CHANNEL_VERSION,
  DIR,
  SYNC_FILE,
  MEDIA_DIR,
  MAX_CONSECUTIVE_FAILURES,
  BACKOFF_DELAY_MS,
  RETRY_DELAY_MS,
  errorText,
  log,
  logError,
} from "./config.js";
import type { AccountData } from "./types.js";
import { MSG_TYPE_USER } from "./types.js";

import { loadAllowlist, isAllowed, getNickname } from "./allowlist.js";
import { loadCredentials, getUpdates, sendText } from "./ilink-api.js";
import { uploadAndSendMedia, extractContent } from "./media.js";
import {
  contextTokens,
  loadContextTokens,
  saveContextTokens,
  appendChatLog,
  replayHistory,
} from "./chat-log.js";
import { reloadHeartbeat, startHeartbeat } from "./heartbeat.js";

// ── Rate limiter for outbound messages ────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const outboundTimestamps: number[] = [];

const LOGIN_REQUIRED = [
  "未找到微信登录信息。",
  "下一步：在 claude-code-wechat 仓库目录运行 bun cli.ts setup。",
  "需要用户用微信扫码登录。",
].join("\n");

const RATE_LIMITED = [
  "发送太快，已触发微信出站消息限速。",
  `下一步：等待约 ${Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)} 秒后重试。`,
].join("\n");

function missingContextMessage(senderId: string): string {
  return [
    `无法发送：缺少 ${senderId} 的 context_token。`,
    "下一步：请让这个微信用户先给 ClawBot 发一条消息，然后再重试。",
  ].join("\n");
}

function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove timestamps outside window
  while (outboundTimestamps.length > 0 && outboundTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    outboundTimestamps.shift();
  }
  if (outboundTimestamps.length >= RATE_LIMIT_MAX) {
    logError(`出站消息速率限制：${RATE_LIMIT_MAX} 条/分钟`);
    return false;
  }
  outboundTimestamps.push(now);
  return true;
}

// ── Ensure media dir exists ──────────────────────────────────────────────────

try {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch (err) {
  logError(`创建 media 目录失败: ${errorText(err)}。下一步：检查 ~/.claude/channels/wechat 目录权限。`);
}

// ── MCP Channel Server ──────────────────────────────────────────────────────

const MINIMAX_SCRIPT = path.join(
  process.env.HOME || "~",
  ".claude",
  "scripts",
  "minimax-voice.sh",
);

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      '来自微信的消息以 <channel source="wechat" sender="..." sender_id="..."> 格式到达。',
      "使用 wechat_reply 工具回复，必须传入消息中的 sender_id。",
      "用中文回复，除非用户用其他语言。",
      "保持简洁——微信是聊天应用，不是写文章。",
      "用纯文本回复，不要用 markdown（微信不渲染）。",
      "sender 为 system 的是系统消息（如历史记录回放），仅用于提供上下文，严禁调用 wechat_reply 回复系统消息。",
      "用户可能不在电脑前。sender 为 permission 的是权限审批请求——用自然的方式告诉用户你想做什么，并提醒他回复 yes/no + 请求ID（5个字母）来批准或拒绝。",
      "不要通过微信输出密码、token、密钥等敏感信息。",
      "如果用户发的是闲聊而不是工作指令，自然聊天就好。",
      "如果需要给用户发送文件、图片或视频，使用 wechat_send_file 工具，传入 sender_id 和本地文件绝对路径或 HTTPS URL。",
      "如果想给用户发语音消息，使用 wechat_send_voice 工具，传入 sender_id 和要说的文字。需要自备 TTS 脚本，发送为 mp3 文件。",
      "sender 为 heartbeat 的是定时提醒。收到后根据时间段给用户发一条自然的微信消息——早上问好、晚上提醒休息、其他时间随意聊两句。不要机械化，像平时聊天一样。但如果你和用户正在聊天，就不需要因为heartbeat额外发消息——你已经在陪他了。sender_id 里有用户的 wechat ID，用它来回复。",
    ].join("\n"),
  },
);

// ── Permission Relay ─────────────────────────────────────────────────────────

// Regex: "y abcde", "yes abcde", "n abcde", "no abcde" (ID is 5 lowercase letters, no 'l')
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// Handle permission request from Claude Code

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // 硬编码直发微信，不经过 Claude，最快速度
  const list = loadAllowlist();
  for (const entry of list.allowed) {
    const ctxToken = contextTokens.get(entry.id);
    if (!ctxToken || !account) continue;

    const prompt = `Claude 想执行 ${params.tool_name}: ${params.description}\n\n要允许吗？\n回复 yes ${params.request_id} 批准\n回复 no ${params.request_id} 拒绝`;

    try {
      await sendText(account.baseUrl, account.token, entry.id, prompt, ctxToken);
      log(`🔐 权限请求已直发微信: ${params.tool_name} (${params.request_id})`);
    } catch (err) {
      logError(`权限请求发送失败: ${errorText(err)}。下一步：确认该用户最近发过消息并且 context_token 仍有效。`);
    }
  }
});

// ── Tool Definitions ─────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "wechat_reply",
      description: "发送文本回复到微信用户",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "来自 <channel> 标签的 sender_id（xxx@im.wechat 格式）",
          },
          text: {
            type: "string",
            description: "要发送的纯文本消息（不支持 markdown）",
          },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_send_file",
      description: "发送文件、图片或视频到微信。支持本地路径和 HTTPS URL（URL 会自动下载后发送，不需要先手动下载）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "来自 <channel> 标签的 sender_id（xxx@im.wechat 格式）",
          },
          file_path_or_url: {
            type: "string",
            description: "本地文件绝对路径或 HTTPS URL。传 URL 时会自动下载，不需要先 curl。",
          },
        },
        required: ["sender_id", "file_path_or_url"],
      },
    },
    {
      name: "wechat_send_voice",
      description: "通过 TTS 合成语音并以 mp3 文件发送到微信。需要自备 TTS 脚本。",
      inputSchema: {
        type: "object" as const,
        properties: {
          sender_id: {
            type: "string",
            description: "来自 <channel> 标签的 sender_id（xxx@im.wechat 格式）",
          },
          text: {
            type: "string",
            description: "要合成语音的文字内容",
          },
        },
        required: ["sender_id", "text"],
      },
    },
    {
      name: "wechat_reload_heartbeat",
      description: "重新加载 heartbeat 配置并重新生成今日时间表。用于手动触发配置更新。",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
  ],
}));

// ── Tool Handlers ────────────────────────────────────────────────────────────

let account: AccountData | null = null;

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!account) {
    return {
      content: [{ type: "text" as const, text: LOGIN_REQUIRED }],
    };
  }

  // ── wechat_reload_heartbeat ──
  if (req.params.name === "wechat_reload_heartbeat") {
    try {
      const count = reloadHeartbeat(mcp);
      return {
        content: [{
          type: "text" as const,
          text: `heartbeat reloaded: ${count} entries scheduled for today`,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `heartbeat 重载失败。\n下一步：检查 ~/.claude/channels/wechat/heartbeat-config.json 是否是合法 JSON。\n详情：${errorText(err)}`,
        }],
      };
    }
  }

  // ── wechat_send_file ──
  if (req.params.name === "wechat_send_file") {
    const { sender_id, file_path_or_url } = req.params.arguments as {
      sender_id: string;
      file_path_or_url: string;
    };
    const file_path = file_path_or_url;

    const ctxToken = contextTokens.get(sender_id);
    if (!ctxToken) {
      return {
        content: [
          { type: "text" as const, text: missingContextMessage(sender_id) },
        ],
      };
    }

    if (!checkRateLimit()) {
      return { content: [{ type: "text" as const, text: RATE_LIMITED }] };
    }

    try {
      let localPath = file_path;

      // URL support: download to temp dir first
      if (file_path.startsWith("http://") || file_path.startsWith("https://")) {
        log(`📥 下载远程文件: ${file_path.slice(0, 80)}...`);
        const dlController = new AbortController();
        const dlTimer = setTimeout(() => dlController.abort(), 30_000);
        try {
          const res = await fetch(file_path, { signal: dlController.signal });
          clearTimeout(dlTimer);
          if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
          // Check file size before downloading body
          const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
          if (contentLength > 100 * 1024 * 1024) {
            throw new Error(`文件过大: ${contentLength} bytes (上限 100MB)`);
          }
          // Determine extension from Content-Type header, then URL, then fallback
          const contentType = res.headers.get("content-type") || "";
          const ctExtMap: Record<string, string> = {
            "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
            "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3",
            "application/pdf": ".pdf",
          };
          const ctExt = Object.entries(ctExtMap).find(([ct]) => contentType.includes(ct))?.[1];
          const urlExt = path.extname(new URL(file_path).pathname);
          const ext = ctExt || (urlExt && urlExt !== "" ? urlExt : ".bin");
          const tempPath = path.join(MEDIA_DIR, `dl_${Date.now()}${ext}`);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(tempPath, buf);
          localPath = tempPath;
          log(`📥 下载完成: ${buf.length} bytes (${contentType}) → ${tempPath}`);
        } catch (err) {
          clearTimeout(dlTimer);
          throw err;
        }
      }

      if (!fs.existsSync(localPath)) {
        return {
          content: [{
            type: "text" as const,
            text: `文件不存在：${localPath}\n下一步：传入本机存在的绝对路径，或传入可访问的 HTTPS URL。`,
          }],
        };
      }

      await uploadAndSendMedia(account.baseUrl, account.token, sender_id, localPath, ctxToken);
      const nick = getNickname(sender_id);
      const displayName = file_path.startsWith("http") ? path.basename(new URL(file_path).pathname) : path.basename(file_path);
      log(`📤 发送文件给 ${nick}: ${displayName}`);
      appendChatLog({
        ts: new Date().toISOString(),
        direction: "out",
        from: "Claude",
        text: `[发送文件] ${displayName}`,
      });
      return { content: [{ type: "text" as const, text: `sent: ${displayName}` }] };
    } catch (err) {
      const errMsg = errorText(err);
      logError(`文件发送失败: ${errMsg}`);
      return {
        content: [{ type: "text" as const, text: `文件发送失败。\n下一步：确认文件路径/URL 可访问，文件大小不超过 100MB，然后重试。\n详情：${errMsg}` }],
      };
    }
  }

  // ── wechat_send_voice ──
  if (req.params.name === "wechat_send_voice") {
    const { sender_id, text } = req.params.arguments as {
      sender_id: string;
      text: string;
    };

    const ctxToken = contextTokens.get(sender_id);
    if (!ctxToken) {
      return {
        content: [{ type: "text" as const, text: missingContextMessage(sender_id) }],
      };
    }

    if (!checkRateLimit()) {
      return { content: [{ type: "text" as const, text: RATE_LIMITED }] };
    }

    try {
      // 生成 mp3，作为文件发送（SILK 语音条 ilink API 暂不支持 bot 发送）
      const { execFileSync } = await import("node:child_process");
      const mp3Path = path.join(MEDIA_DIR, `voice_${Date.now()}.mp3`);
      log(`🎙️ 语音合成: "${text.slice(0, 30)}..."`);
      execFileSync("bash", [MINIMAX_SCRIPT, text, mp3Path], { timeout: 30_000, stdio: "pipe" });
      if (!fs.existsSync(mp3Path)) throw new Error("MiniMax 语音合成失败");
      await uploadAndSendMedia(account.baseUrl, account.token, sender_id, mp3Path, ctxToken);
      const nick = getNickname(sender_id);
      log(`🎙️ 语音发送给 ${nick}: "${text.slice(0, 30)}..."`);
      appendChatLog({
        ts: new Date().toISOString(),
        direction: "out",
        from: "Claude",
        text: `[语音] ${text}`,
      });
      return { content: [{ type: "text" as const, text: `voice sent: "${text.slice(0, 50)}"` }] };
    } catch (err) {
      const errMsg = errorText(err);
      const stderr = (err as any)?.stderr instanceof Buffer
        ? (err as any).stderr.toString().trim()
        : "";
      const detail = stderr ? `${errMsg}\nstderr: ${stderr}` : errMsg;
      logError(`语音发送失败: ${detail}`);
      return {
        content: [{ type: "text" as const, text: `语音发送失败。\n下一步：确认 ~/.claude/scripts/minimax-voice.sh 存在且可执行；不需要语音时请改用 wechat_reply。\n详情：${detail}` }],
      };
    }
  }

  // ── wechat_reply ──
  if (req.params.name !== "wechat_reply") {
    throw new Error(`未知工具：${req.params.name}。可用工具：wechat_reply、wechat_send_file、wechat_send_voice、wechat_reload_heartbeat。`);
  }

  const { sender_id, text } = req.params.arguments as {
    sender_id: string;
    text: string;
  };

  const ctxToken = contextTokens.get(sender_id);
  if (!ctxToken) {
    return {
      content: [
        {
          type: "text" as const,
          text: missingContextMessage(sender_id),
        },
      ],
    };
  }

  if (!checkRateLimit()) {
    return { content: [{ type: "text" as const, text: RATE_LIMITED }] };
  }

  try {
    await sendText(account.baseUrl, account.token, sender_id, text, ctxToken);
    const nick = getNickname(sender_id);
    log(`→ 回复 ${nick}: ${text}`);

    // Save to chat log
    appendChatLog({
      ts: new Date().toISOString(),
      direction: "out",
      from: "Claude",
      text,
    });

    return { content: [{ type: "text" as const, text: "sent" }] };
  } catch (err) {
    const errMsg = errorText(err);
    // Token expired detection
    if (errMsg.includes("401") || errMsg.includes("unauthorized") || errMsg.includes("token")) {
      logError("bot_token 可能已过期。下一步：在 claude-code-wechat 仓库目录运行 bun cli.ts setup，并让用户重新扫码。");
    }
    return {
      content: [
        { type: "text" as const, text: `微信回复发送失败。\n下一步：如果详情包含 401/token/auth，请在 claude-code-wechat 仓库目录运行 bun cli.ts setup 重新扫码；否则稍后重试。\n详情：${errMsg}` },
      ],
    };
  }
});

// ── Long-poll loop ───────────────────────────────────────────────────────────

async function startPolling(acct: AccountData): Promise<never> {
  const { baseUrl, token } = acct;
  let syncBuf = "";
  let consecutiveFailures = 0;

  // Restore sync state
  try {
    if (fs.existsSync(SYNC_FILE)) {
      syncBuf = fs.readFileSync(SYNC_FILE, "utf-8");
      log(`恢复同步状态 (${syncBuf.length} bytes)`);
    }
  } catch {}

  // Restore context tokens
  loadContextTokens();

  log("开始监听微信消息...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, syncBuf);

      // Handle API errors
      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        consecutiveFailures++;
        const errMsg = resp.errmsg ?? "";

        // Token expired detection
        if (errMsg.includes("token") || errMsg.includes("auth") || resp.errcode === 401) {
          logError("bot_token 可能已过期。下一步：在 claude-code-wechat 仓库目录运行 bun cli.ts setup，并让用户重新扫码。");
        }

        logError(
          `getupdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${errMsg}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError(`连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，等待 ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buffer
      if (resp.get_updates_buf) {
        syncBuf = resp.get_updates_buf;
        try {
          fs.writeFileSync(SYNC_FILE, syncBuf, "utf-8");
        } catch {}
      }

      // Process messages
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const text = await extractContent(msg);
        if (!text) {
          // Tier 2: log unhandled messages for future debugging
          try {
            const entry = { ts: new Date().toISOString(), type: "empty_content", message_type: msg.message_type, items: msg.item_list };
            fs.appendFileSync(path.join(DIR, "unhandled.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
          } catch {}
          continue;
        }

        const senderId = msg.from_user_id ?? "unknown";

        // Cache and persist context token
        if (msg.context_token) {
          contextTokens.set(senderId, msg.context_token);
          saveContextTokens();
        }

        // Security gate: sender allowlist
        if (!isAllowed(senderId)) {
          log(`⛔ 拒绝未授权 sender: ${senderId} (消息: ${text.slice(0, 30)}...)`);
          log(`   如需允许，运行: bun setup.ts --allow ${senderId}`);
          continue;
        }

        const nick = getNickname(senderId);

        // Check if this is a permission verdict reply
        const permMatch = PERMISSION_REPLY_RE.exec(text);
        if (permMatch) {
          const requestId = permMatch[2].toLowerCase();
          const behavior = permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny";
          await mcp.notification({
            method: "notifications/claude/channel/permission",
            params: { request_id: requestId, behavior },
          });
          log(`🔐 权限${behavior === "allow" ? "批准" : "拒绝"}: ${requestId}`);
          appendChatLog({
            ts: new Date().toISOString(),
            direction: "in",
            from: nick,
            text: `[权限${behavior === "allow" ? "批准" : "拒绝"}] ${requestId}`,
          });
          continue;
        }

        log(`← ${nick}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        // Push to Claude Code session
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: text,
            meta: {
              sender: nick,
              sender_id: senderId,
            },
          },
        });

        // Save to chat log
        appendChatLog({
          ts: new Date().toISOString(),
          direction: "in",
          from: nick,
          text,
        });
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`轮询异常: ${errorText(err)}。下一步：如果连续出现 auth/token/401，请在 claude-code-wechat 仓库目录运行 bun cli.ts setup 重新扫码。`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.on('unhandledRejection', (reason) => {
    logError(`Unhandled rejection: ${errorText(reason)}`);
  });

  await mcp.connect(new StdioServerTransport());
  log("MCP 连接就绪");

  const creds = loadCredentials();
  if (!creds) {
    logError(LOGIN_REQUIRED);
    process.exit(1);
  }
  account = creds;

  log(`账号: ${creds.accountId}`);

  const list = loadAllowlist();
  if (list.allowed.length === 0 && !list.auto_allow_next) {
    log("⚠️  allowlist 为空。运行 bun setup.ts --allow-all 或 --allow <ID> 添加授权用户");
  } else {
    for (const entry of list.allowed) {
      log(`  允许: ${entry.nickname} (${entry.id})`);
    }
  }

  // Wait 2s for Claude Code to finish processing the MCP handshake and register
  // the notification listener. Without this delay, the history replay notification
  // may arrive before Claude Code is ready to receive channel events.
  await new Promise((r) => setTimeout(r, 2000));

  // Replay recent chat history for context
  await replayHistory(mcp);

  // Start heartbeat timer (before startPolling which never returns)
  startHeartbeat(mcp);

  await startPolling(creds);
}

main().catch((err) => {
  logError(`Fatal: ${errorText(err)}`);
  process.exit(1);
});
