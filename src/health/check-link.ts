// src/health/check-link.ts

import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { TurnConfig } from "../config/types";
import { VK_TURN_CLIENT_PATH, VPS_PUBLIC_IP } from "../config/config";

const execAsync = promisify(exec);

// ─── Проверка здоровья ссылки ───────────────────────────────

/** Проверяет валидность VK call link через TURN-клиент (до maxAttempts попыток) */
export async function checkLinkHealth(
  link: string,
  config: TurnConfig,
  onAttempt?: (attempt: number) => void,
  maxAttempts = 5,
  intervalMs = 10_000,
): Promise<{ alive: boolean; attempts: number; error?: string }> {
  if (!existsSync(VK_TURN_CLIENT_PATH) || !VPS_PUBLIC_IP) {
    const reason = !existsSync(VK_TURN_CLIENT_PATH) ? "нет клиента" : "не задан VPS_PUBLIC_IP";
    return { alive: true, attempts: 0, error: `Ссылка не проверена — ${reason}` };
  }

  for (let i = 1; i <= maxAttempts; i++) {
    if (onAttempt) onAttempt(i);

    try {
      await execAsync(
        `timeout 15 ${VK_TURN_CLIENT_PATH} ` +
          `-vk-link "${link}" ` +
          `-peer ${config.wgPeerAddress}:${config.turnListenPort} ` +
          `-listen 127.0.0.1:0 ` +
          `-n 1 2>&1`,
        { timeout: 20_000 }
      );
      return { alive: true, attempts: i };
    } catch (error: any) {
      if (error?.killed || error?.signal === "SIGTERM" || error?.code === 124) {
        return { alive: true, attempts: i };
      }

      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        return { alive: false, attempts: i, error: msg.slice(0, 200) };
      }
    }
  }

  return { alive: false, attempts: maxAttempts };
}
