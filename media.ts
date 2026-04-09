/**
 * Media handling: AES encrypt/decrypt, CDN download/upload, voice synthesis.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DIR,
  CHANNEL_VERSION,
  CDN_DOWNLOAD_URL,
  CDN_UPLOAD_URL,
  MEDIA_DIR,
  log,
  logError,
} from "./config.js";
import type { MessageItem, DownloadedMedia } from "./types.js";
import {
  MSG_TYPE_BOT,
  MSG_STATE_FINISH,
  MSG_ITEM_TEXT,
  UPLOAD_MEDIA_TYPE,
} from "./types.js";
import { apiFetch, generateClientId } from "./ilink-api.js";

// ── AES Helpers ──────────────────────────────────────────────────────────────

export function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function parseAesKey(hexOrBase64: string): Buffer {
  // Direct hex key (32 chars = 16 bytes)
  if (/^[0-9a-fA-F]{32}$/.test(hexOrBase64)) {
    return Buffer.from(hexOrBase64, "hex");
  }
  // Base64 encoded - decode first
  const decoded = Buffer.from(hexOrBase64, "base64");
  // Check if the decoded content is a hex string (base64(hex) pattern)
  const decodedStr = decoded.toString("utf-8");
  if (/^[0-9a-fA-F]{32}$/.test(decodedStr)) {
    return Buffer.from(decodedStr, "hex");
  }
  // Raw binary key
  return decoded.subarray(0, 16);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── CDN Download ─────────────────────────────────────────────────────────────

export async function cdnDownload(encryptedQueryParam: string): Promise<Buffer> {
  const url = `${CDN_DOWNLOAD_URL}?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`CDN download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Image Extension Detection ────────────────────────────────────────────────

export function detectImageExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "jpg";
}

// ── Media Download ───────────────────────────────────────────────────────────

export async function downloadMediaItem(item: MessageItem): Promise<DownloadedMedia | null> {
  try {
    const ts = Date.now();

    // Image
    if (item.type === 2 && item.image_item) {
      const queryParam = item.image_item.media?.encrypt_query_param;
      const keyStr = item.image_item.aeskey || item.image_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;

      const encrypted = await cdnDownload(queryParam);
      const key = parseAesKey(keyStr);
      const decrypted = decryptAes128Ecb(encrypted, key);
      const ext = detectImageExt(decrypted);
      const fileName = `img_${ts}.${ext}`;
      const filePath = path.join(MEDIA_DIR, fileName);
      fs.writeFileSync(filePath, decrypted);
      return { type: "image", filePath, fileName };
    }

    // File
    if (item.type === 4 && item.file_item) {
      const queryParam = item.file_item.media?.encrypt_query_param;
      const keyStr = item.file_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;

      const encrypted = await cdnDownload(queryParam);
      const key = parseAesKey(keyStr);
      const decrypted = decryptAes128Ecb(encrypted, key);
      const origName = item.file_item.file_name || `file_${ts}`;
      const fileName = `${ts}_${origName}`;
      const filePath = path.join(MEDIA_DIR, fileName);
      fs.writeFileSync(filePath, decrypted);
      return { type: "file", filePath, fileName: origName };
    }

    // Video — download + ffmpeg frame extraction + audio extraction
    if (item.type === 5 && item.video_item) {
      const queryParam = item.video_item.media?.encrypt_query_param;
      const keyStr = item.video_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;

      const encrypted = await cdnDownload(queryParam);
      const key = parseAesKey(keyStr);
      const decrypted = decryptAes128Ecb(encrypted, key);
      const fileName = `video_${ts}.mp4`;
      const filePath = path.join(MEDIA_DIR, fileName);
      fs.writeFileSync(filePath, decrypted);

      const framesDir = path.join(MEDIA_DIR, `video_${ts}_frames`);
      const framePaths: string[] = [];
      try {
        fs.mkdirSync(framesDir, { recursive: true });
        const { execFileSync } = await import("node:child_process");

        let duration = 0;
        try {
          const out = execFileSync(
            "ffprobe",
            ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          duration = parseFloat(out) || 0;
        } catch {}

        if (duration > 0) {
          const frameCount = Math.min(4, Math.max(1, Math.floor(duration)));
          const interval = duration / (frameCount + 1);
          for (let i = 1; i <= frameCount; i++) {
            const seekTo = (interval * i).toFixed(2);
            const fp = path.join(framesDir, `frame_${i}.jpg`);
            try {
              execFileSync(
                "ffmpeg",
                ["-y", "-ss", seekTo, "-i", filePath, "-vframes", "1", "-q:v", "2", fp],
                { timeout: 15_000, stdio: "pipe" },
              );
              framePaths.push(fp);
            } catch {}
          }
          log(`📎 视频抽帧: ${framePaths.length} 帧 → ${framesDir}`);
        }

        // Extract audio
        const audioFile = path.join(MEDIA_DIR, `video_${ts}_audio.wav`);
        try {
          execFileSync(
            "ffmpeg",
            ["-y", "-i", filePath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", audioFile],
            { timeout: 15_000, stdio: "pipe" },
          );
          log(`📎 视频音频: ${audioFile}`);
        } catch {}
      } catch (err) {
        logError(`视频处理失败: ${String(err)}`);
      }

      return { type: "video", filePath, fileName };
    }

    // Voice (download audio file)
    if (item.type === 3 && item.voice_item?.media) {
      const queryParam = item.voice_item.media.encrypt_query_param;
      const keyStr = item.voice_item.media.aes_key;
      if (!queryParam || !keyStr) return null;

      const encrypted = await cdnDownload(queryParam);
      const key = parseAesKey(keyStr);
      const decrypted = decryptAes128Ecb(encrypted, key);
      const fileName = `voice_${ts}.silk`;
      const filePath = path.join(MEDIA_DIR, fileName);
      fs.writeFileSync(filePath, decrypted);
      return { type: "voice", filePath, fileName };
    }
  } catch (err) {
    logError(`媒体下载失败: ${String(err)}`);
    // Tier 2: log failed media item
    try {
      const entry = { ts: new Date().toISOString(), type: "media_failed", item_type: item.type, error: String(err), item };
      fs.appendFileSync(path.join(DIR, "unhandled.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
    } catch {}
  }
  return null;
}

// ── MIME Type Detection ──────────────────────────────────────────────────────

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimes: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    ".pdf": "application/pdf", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip", ".txt": "text/plain", ".md": "text/markdown",
  };
  return mimes[ext] || "application/octet-stream";
}

// ── Media Upload + Send ──────────────────────────────────────────────────────

export async function uploadAndSendMedia(
  baseUrl: string,
  token: string,
  to: string,
  filePath: string,
  contextToken: string,
): Promise<void> {
  const plaintext = fs.readFileSync(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  // Determine upload media type and message item type
  const mime = getMimeType(filePath);
  let uploadMediaType: number;
  let itemType: number;

  if (mime.startsWith("image/")) {
    uploadMediaType = UPLOAD_MEDIA_TYPE.IMAGE;
    itemType = 2; // MSG_ITEM_IMAGE
  } else if (mime.startsWith("video/")) {
    uploadMediaType = UPLOAD_MEDIA_TYPE.VIDEO;
    itemType = 5; // MSG_ITEM_VIDEO
  } else {
    uploadMediaType = UPLOAD_MEDIA_TYPE.FILE;
    itemType = 4; // MSG_ITEM_FILE
  }

  log(`📤 上传: ${path.basename(filePath)} (${rawsize} bytes, type=${itemType})`);

  // Step 1: Get upload URL
  const uploadUrlResp = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey,
      media_type: uploadMediaType,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  const uploadUrlData = JSON.parse(uploadUrlResp.text) as { upload_param?: string };
  const uploadParam = uploadUrlData.upload_param;
  if (!uploadParam) {
    throw new Error("getuploadurl 未返回 upload_param");
  }

  // Step 2: Encrypt and upload to CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = `${CDN_UPLOAD_URL}?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  const cdnRes = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!cdnRes.ok) {
    throw new Error(`CDN 上传失败: ${cdnRes.status}`);
  }
  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN 响应缺少 x-encrypted-param header");
  }

  // Step 3: Send message with media reference
  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const mediaRef = {
    encrypt_query_param: downloadParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1,
  };

  let mediaItem: Record<string, any>;
  if (itemType === 2) {
    mediaItem = { type: 2, image_item: { media: mediaRef, mid_size: filesize } };
  } else if (itemType === 5) {
    mediaItem = { type: 5, video_item: { media: mediaRef, video_size: filesize } };
  } else {
    mediaItem = {
      type: 4,
      file_item: { media: mediaRef, file_name: path.basename(filePath), len: String(rawsize) },
    };
  }

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [mediaItem],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });

  log(`📤 发送成功: ${path.basename(filePath)}`);
}

// ── Content Extraction ───────────────────────────────────────────────────────

export async function extractContent(msg: { item_list?: MessageItem[] }): Promise<string> {
  if (!msg.item_list?.length) return "";

  const parts: string[] = [];

  for (const item of msg.item_list) {
    // Text
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      let text = item.text_item.text;
      const refText = item.ref_msg?.title || item.ref_msg?.message_item?.text_item?.text;
      if (refText) {
        text = `[引用: ${refText}]\n${text}`;
      }
      parts.push(text);
      continue;
    }

    // Voice with ASR text
    if (item.type === 3 && item.voice_item?.text) {
      parts.push(`[语音] ${item.voice_item.text}`);
      continue;
    }

    // Media: try to download
    if (item.type === 2 || item.type === 3 || item.type === 4 || item.type === 5) {
      const media = await downloadMediaItem(item);
      if (media) {
        const labels: Record<string, string> = {
          image: "图片",
          voice: "语音文件",
          file: "文件",
          video: "视频",
        };
        parts.push(`[${labels[media.type]}] 已保存到 ${media.filePath}`);
        if (media.type === "image") {
          parts.push(`请用 Read 工具查看该图片文件来了解图片内容。`);
        }
        log(`📎 ${labels[media.type]}: ${media.filePath}`);

        // For videos, list extracted frames so Claude can read them
        if (media.type === "video") {
          const framesDir = media.filePath.replace(".mp4", "_frames");
          try {
            const frames = fs.readdirSync(framesDir).filter((f: string) => f.endsWith(".jpg")).sort();
            if (frames.length > 0) {
              parts.push(`[视频关键帧] 共 ${frames.length} 帧:`);
              for (const frame of frames) {
                parts.push(`  ${path.join(framesDir, frame)}`);
              }
            }
          } catch {}
          // Check for extracted audio
          const audioFile = media.filePath.replace(".mp4", "_audio.wav");
          if (fs.existsSync(audioFile)) {
            parts.push(`[视频音频] ${audioFile}`);
          }
        }
      } else {
        const typeNames: Record<number, string> = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };
        parts.push(`[${typeNames[item.type] || "未知媒体"}] (无法下载)`);
      }
      continue;
    }
  }

  return parts.join("\n");
}
