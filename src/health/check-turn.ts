// src/health/check-turn.ts

import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import {
  SYSTEMD_SERVICE,
  VK_TURN_CLIENT_PATH,
  VPS_PUBLIC_IP,
  CREDS_URL,
  loadConfig,
} from "../config/config";

const execAsync = promisify(exec);

// ─── Проверка здоровья TURN ─────────────────────────────────

/**
 * Проверяет, жива ли связка vk-turn-proxy.
 *
 * Стратегия: запускаем клиент vk-turn-proxy с таймаутом 15 сек.
 * Если клиент успевает установить TURN-соединение — ссылка жива.
 * Если таймаут или ошибка — ссылка мертва.
 *
 * Альтернатива: проверяем, что systemd-сервис активен
 * и есть активные UDP-сокеты на нужном порту.
 */
export async function checkTurnHealth(): Promise<{
  alive: boolean;
  details: string;
}> {
  const config = loadConfig();

  if (!config.vkCallLink) {
    return { alive: false, details: "Ссылка на VK-звонок не задана" };
  }

  try {
    // Проверка 1: systemd-сервис запущен?
    const { stdout: serviceStatus } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE} 2>/dev/null || echo "inactive"`
    );

    if (serviceStatus.trim() !== "active") {
      return {
        alive: false,
        details: `Сервис ${SYSTEMD_SERVICE} не запущен (${serviceStatus.trim()})`,
      };
    }

    // Проверка 2: есть ли активные UDP-соединения на порту?
    const { stdout: connections } = await execAsync(
      `ss -unlp | grep ":${config.turnListenPort}" | wc -l`
    );

    const connCount = parseInt(connections.trim(), 10);

    if (connCount === 0) {
      return {
        alive: false,
        details: "Сервис запущен, но нет активных UDP-соединений",
      };
    }

    // Проверка 3: пробуем подключиться клиентом с коротким таймаутом.
    if (existsSync(VK_TURN_CLIENT_PATH) && VPS_PUBLIC_IP) {
      try {
        await execAsync(
          `timeout 10 ${VK_TURN_CLIENT_PATH} ` +
            `-vk-link "${config.vkCallLink}" ` +
            `-peer ${VPS_PUBLIC_IP}:${config.turnListenPort} ` +
            `-listen 127.0.0.1:0 ` +
            `-creds-url "${CREDS_URL}" ` +
            `-n 1 2>&1`,
          { timeout: 15_000 }
        );
      } catch (error: any) {
        if (error.code === 124 || error.killed) {
          // Нормально: клиент работал до таймаута
        } else {
          const output = (error.stdout || error.stderr || "").trim();
          const reason =
            output.split("\n").slice(0, 3).join("\n") || error.message;
          return {
            alive: false,
            details: `Сервис активен, но ссылка не работает:\n${reason}`,
          };
        }
      }
    }

    if (!existsSync(VK_TURN_CLIENT_PATH) || !VPS_PUBLIC_IP) {
      const reason = !existsSync(VK_TURN_CLIENT_PATH)
        ? "нет клиента"
        : "не задан VPS_PUBLIC_IP";
      return {
        alive: true,
        details: `Сервис активен, ${connCount} UDP (ссылка не проверена — ${reason})`,
      };
    }

    return {
      alive: true,
      details: `Всё ОК: сервис активен, ${connCount} UDP, ссылка работает`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { alive: false, details: `Ошибка проверки: ${msg}` };
  }
}
