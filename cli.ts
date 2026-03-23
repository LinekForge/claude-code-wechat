#!/usr/bin/env node
/**
 * CLI entry point for npx claude-code-wechat.
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "setup") {
  process.argv = [process.argv[0], "setup.ts", ...args.slice(1)];
  await import("./setup.js");
} else if (cmd === "install") {
  // Generate .mcp.json in current directory
  // Find the package root (where package.json is)
  let pkgDir = path.dirname(new URL(import.meta.url).pathname);
  // If running from dist/, go up one level
  if (pkgDir.endsWith("/dist")) pkgDir = path.dirname(pkgDir);
  // Use compiled JS (node-compatible) by default, fall back to .ts (bun) if dist doesn't exist
  const distServer = path.join(pkgDir, "dist", "wechat-channel.js");
  const srcServer = path.join(pkgDir, "wechat-channel.ts");
  const serverPath = fs.existsSync(distServer) ? distServer : srcServer;
  const command = serverPath.endsWith(".js") ? "node" : "bun";

  const mcpConfig = {
    mcpServers: {
      wechat: {
        command: command,
        args: [serverPath],
      },
    },
  };

  // Write to .mcp.json in current directory
  const mcpJsonPath = path.join(process.cwd(), ".mcp.json");

  // Merge with existing if present
  let existing: any = {};
  try {
    existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
  } catch {}

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.wechat = mcpConfig.mcpServers.wechat;

  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");

  console.log(`✅ MCP 配置已写入 ${mcpJsonPath}`);
  console.log(`   server: ${serverPath}`);
  console.log(`   command: ${command}`);
  console.log();
  console.log("下一步：");
  console.log("  claude --dangerously-load-development-channels server:wechat");
} else {
  console.log(`claude-code-wechat v0.2.0

Usage:
  npx claude-code-wechat setup              扫码登录微信
  npx claude-code-wechat install             生成 MCP 配置
  npx claude-code-wechat setup --allow-all  开启自动白名单
  npx claude-code-wechat setup --allow ID   添加白名单
  npx claude-code-wechat setup --list       查看白名单

启动 Channel:
  claude --dangerously-load-development-channels server:wechat

详细文档: https://github.com/LinekForge/claude-code-wechat`);
}

export {};
