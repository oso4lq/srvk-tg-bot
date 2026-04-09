// src/config/config.ts

import { readFileSync, writeFileSync, existsSync } from "fs";
import { TurnConfig, DEFAULT_DAILY_STATS } from "./types";

// ─── Конфигурация среды ─────────────────────────────────────

export const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/vk-turn-proxy/config.json";
export const SYSTEMD_SERVICE = process.env.SYSTEMD_SERVICE || "vk-turn-proxy";
export const VK_TURN_CLIENT_PATH = process.env.VK_TURN_CLIENT_PATH || "/usr/local/bin/vk-turn-client";
export const VPS_PUBLIC_IP = process.env.VPS_PUBLIC_IP || "";
export const CREDS_SERVER_PORT = Number(process.env.CREDS_SERVER_PORT) || 3100;
export const CREDS_URL = `http://127.0.0.1:${CREDS_SERVER_PORT}/creds`;

// ─── Работа с конфигом ──────────────────────────────────────

export function loadConfig(): TurnConfig {
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig: TurnConfig = {
      vkCallLink: "",
      wgPeerAddress: process.env.WG_PEER_IP || "127.0.0.1",
      wgPeerPort: Number(process.env.WG_PEER_PORT) || 51820,
      turnListenPort: Number(process.env.VK_TURN_LISTEN_PORT) || 56000,
      updatedAt: new Date().toISOString(),
      stats: {
        totalRestarts: 0,
        lastCheckOk: false,
        lastCheckAt: "",
        lastCheckDetails: "",
        uptimeSince: new Date().toISOString(),
      },
      dailyStats: DEFAULT_DAILY_STATS(),
      monitoringEnabled: true,
      linkQueue: [],
    };
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // Backwards compat
  if (!raw.dailyStats) raw.dailyStats = DEFAULT_DAILY_STATS();
  if (!raw.stats.lastCheckDetails) raw.stats.lastCheckDetails = "";
  if (raw.monitoringEnabled === undefined) raw.monitoringEnabled = true;
  if (!Array.isArray(raw.linkQueue)) raw.linkQueue = [];
  return raw as TurnConfig;
}

export function saveConfig(config: TurnConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
