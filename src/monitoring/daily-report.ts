// src/monitoring/daily-report.ts

import { exec } from "child_process";
import { promisify } from "util";
import { bot } from "../bot";
import { SYSTEMD_SERVICE, loadConfig, saveConfig } from "../config/config";
import { checkTurnHealth } from "../health/check-turn";
import {
  formatUptime,
  formatBytes,
  buildReportPage,
  parseSystemdProps,
} from "../utils/format";
import { ADMIN_CHAT_IDS } from "../utils/notify";
import { getServiceTrafficBytes } from "../utils/systemd";

const execAsync = promisify(exec);

// ─── Ежедневный отчёт ────────────────────────────────────────

/** Данные отчётов для пагинации инцидентов (ключ — "chatId:msgId") */
export const pendingReports = new Map<string, {
  header: string;
  incidents: string[];
  timeout: ReturnType<typeof setTimeout>;
}>();

async function sendDailyReport(): Promise<void> {
  const config = loadConfig();
  const ds = config.dailyStats;

  // Текущий статус
  const health = await checkTurnHealth();

  // Сервис из systemd
  let serviceState = "неизвестно";
  let serviceUptime = "";
  try {
    const { stdout } = await execAsync(
      `systemctl show ${SYSTEMD_SERVICE} --property=ActiveState,ActiveEnterTimestamp,MemoryCurrent 2>/dev/null`
    );
    const props = parseSystemdProps(stdout);
    serviceState = props.ActiveState || "неизвестно";
    if (props.ActiveEnterTimestamp && serviceState === "active") {
      serviceUptime = formatUptime(
        new Date(props.ActiveEnterTimestamp).toISOString()
      );
    }
    const mem = parseInt(props.MemoryCurrent || "0", 10);
    if (mem > 0) serviceState += `, ${(mem / 1024 / 1024).toFixed(1)} МБ`;
  } catch {}

  // Подключения (текущие UDP-сессии)
  let connCount = 0;
  try {
    const { stdout } = await execAsync(
      `ss -unp | grep ":${config.turnListenPort}" | wc -l`
    );
    connCount = parseInt(stdout.trim(), 10);
  } catch {}

  // Трафик (через systemd IPAccounting)
  const currentBytes = await getServiceTrafficBytes();
  const deltaBytes = currentBytes > ds.trafficSnapshotBytes
    ? currentBytes - ds.trafficSnapshotBytes
    : currentBytes; // Сервис перезапускался — счётчик сбросился
  const trafficStr = currentBytes > 0
    ? formatBytes(deltaBytes)
    : "н/д (нужен /restart для включения IPAccounting)";

  // Сборка отчёта — заголовок (без инцидентов)
  const headerLines = [
    `📋 Ежедневный отчёт VK TURN Proxy`,
    ``,
    `Статус: ${health.alive ? "✅ OK" : "❌ Fail"}`,
    `Сервис: ${serviceState}`,
    serviceUptime ? `Аптайм сервиса: ${serviceUptime}` : null,
    `Аптайм бота: ${formatUptime(config.stats.uptimeSince)}`,
    `Активные подключения: ${connCount}`,
    `Трафик за сутки: ${trafficStr}`,
    `Ссылок в очереди: ${config.linkQueue.length}`,
    ``,
    `Происшествия: ${ds.failedChecks === 0 ? "нет ✅" : `${ds.failedChecks} ⚠️`}`,
  ];
  const header = headerLines.filter((l) => l !== null).join("\n");

  // Отправка с пагинацией инцидентов
  const { text, keyboard } = buildReportPage(header, ds.incidents, 0);
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      const msg = await bot.api.sendMessage(
        chatId,
        text,
        keyboard ? { reply_markup: keyboard } : undefined
      );
      if (ds.incidents.length > 10) {
        const key = `${chatId}:${msg.message_id}`;
        const timeout = setTimeout(() => pendingReports.delete(key), 24 * 60 * 60_000);
        pendingReports.set(key, {
          header,
          incidents: [...ds.incidents],
          timeout,
        });
      }
    } catch (error) {
      console.error(`Не удалось отправить отчёт ${chatId}:`, error);
    }
  }

  // Сброс дневной статистики
  config.dailyStats = {
    failedChecks: 0,
    incidents: [],
    periodStart: new Date().toISOString(),
    trafficSnapshotBytes: currentBytes,
  };
  config.stats.lastCheckOk = health.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = health.details;
  saveConfig(config);
}

export function scheduleDailyReport(): void {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(4, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  const delay = next.getTime() - now.getTime();
  console.log(`Ежедневный отчёт запланирован на ${next.toISOString()}`);

  setTimeout(() => {
    sendDailyReport().catch(console.error);
    setInterval(
      () => sendDailyReport().catch(console.error),
      24 * 60 * 60 * 1000
    );
  }, delay);
}
