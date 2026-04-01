import { Bot, Context, Keyboard } from "grammy";
import { exec, execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { promisify } from "util";
import "dotenv/config";

const execAsync = promisify(exec);

// ─── Конфигурация ───────────────────────────────────────────

interface TurnConfig {
  /** Текущая ссылка на VK-звонок */
  vkCallLink: string;
  /** IP VPS для WireGuard-пира */
  wgPeerAddress: string;
  /** Порт WireGuard */
  wgPeerPort: number;
  /** Порт vk-turn-proxy сервера */
  turnListenPort: number;
  /** Метка времени последнего обновления ссылки */
  updatedAt: string;
  /** Статистика */
  stats: {
    totalRestarts: number;
    lastCheckOk: boolean;
    lastCheckAt: string;
    lastCheckDetails: string;
    uptimeSince: string;
  };
  /** Дневная статистика (сбрасывается при отправке отчёта) */
  dailyStats: {
    failedChecks: number;
    incidents: string[];
    periodStart: string;
    trafficSnapshotBytes: number;
  };
  /** Мониторинг включён */
  monitoringEnabled: boolean;
}

const BOT_TOKEN = process.env.BOT_TOKEN!;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID!);
const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/vk-turn-proxy/config.json";
const SYSTEMD_SERVICE = process.env.SYSTEMD_SERVICE || "vk-turn-proxy";
const VK_TURN_CLIENT_PATH = process.env.VK_TURN_CLIENT_PATH || "/usr/local/bin/vk-turn-client";
const VK_TURN_SERVER_PATH = process.env.VK_TURN_SERVER_PATH || "/usr/local/bin/vk-turn-server";
const VPS_PUBLIC_IP = process.env.VPS_PUBLIC_IP || "";
const CHECK_INTERVAL_MS = (Number(process.env.CHECK_INTERVAL_MIN) || 5) * 60 * 1000;

// ─── Работа с конфигом ──────────────────────────────────────

const DEFAULT_DAILY_STATS = (): TurnConfig["dailyStats"] => ({
  failedChecks: 0,
  incidents: [],
  periodStart: new Date().toISOString(),
  trafficSnapshotBytes: 0,
});

function loadConfig(): TurnConfig {
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
    };
    saveConfig(defaultConfig);
    return defaultConfig;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // Backwards compat
  if (!raw.dailyStats) raw.dailyStats = DEFAULT_DAILY_STATS();
  if (!raw.stats.lastCheckDetails) raw.stats.lastCheckDetails = "";
  if (raw.monitoringEnabled === undefined) raw.monitoringEnabled = true;
  return raw as TurnConfig;
}

function saveConfig(config: TurnConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

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
async function checkTurnHealth(): Promise<{
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
    // Если ссылка мёртвая — клиент падает с ошибкой до таймаута.
    // Если ссылка живая — клиент работает, и timeout его убивает (код 124).
    if (existsSync(VK_TURN_CLIENT_PATH) && VPS_PUBLIC_IP) {
      try {
        await execAsync(
          `timeout 10 ${VK_TURN_CLIENT_PATH} ` +
            `-vk-link "${config.vkCallLink}" ` +
            `-peer ${VPS_PUBLIC_IP}:${config.turnListenPort} ` +
            `-listen 127.0.0.1:0 ` +
            `-n 1 2>&1`,
          { timeout: 15_000 }
        );
        // Клиент завершился с кодом 0 до таймаута — ОК
      } catch (error: any) {
        // Код 124 = timeout убил процесс → клиент работал → ссылка жива
        if (error.code === 124 || error.killed) {
          // Нормально: клиент работал до таймаута
        } else {
          // Клиент вернул ошибку до таймаута → ссылка не работает
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

// ─── Управление сервисом ────────────────────────────────────

/** Извлекает данные из ссылки VK-звонка и обновляет конфиг */
async function updateCallLink(newLink: string): Promise<string> {
  // Валидация формата ссылки
  const vkCallRegex = /^https:\/\/vk\.(com|ru)\/call\/join\/[A-Za-z0-9_/-]+$/;
  if (!vkCallRegex.test(newLink)) {
    throw new Error(
      "Неверный формат ссылки. Ожидается: https://vk.com/call/join/... или https://vk.ru/call/join/..."
    );
  }

  const config = loadConfig();
  const oldLink = config.vkCallLink;

  config.vkCallLink = newLink;
  config.updatedAt = new Date().toISOString();
  saveConfig(config);

  return oldLink
    ? `Ссылка обновлена.\nСтарая: ${oldLink.slice(0, 40)}...\nНовая: ${newLink.slice(0, 40)}...`
    : `Ссылка установлена: ${newLink.slice(0, 40)}...`;
}

/** Перезапускает vk-turn-proxy сервис с новыми параметрами */
async function restartService(): Promise<string> {
  const config = loadConfig();

  if (!config.vkCallLink) {
    throw new Error("Сначала задай ссылку на VK-звонок через /setlink");
  }

  try {
    // Обновляем аргументы в systemd override
    const overrideContent = [
      "[Service]",
      `IPAccounting=yes`,
      `ExecStart=`,
      `ExecStart=${VK_TURN_SERVER_PATH} \\`,
      `  -listen 0.0.0.0:${config.turnListenPort} \\`,
      `  -connect 127.0.0.1:${config.wgPeerPort}`,
    ].join("\n");

    writeFileSync(
      `/etc/systemd/system/${SYSTEMD_SERVICE}.service.d/override.conf`,
      overrideContent
    );

    await execAsync("systemctl daemon-reload");
    await execAsync(`systemctl restart ${SYSTEMD_SERVICE}`);

    // Ждём 3 секунды и проверяем, что сервис поднялся
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { stdout } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE}`
    );

    config.stats.totalRestarts++;
    config.stats.uptimeSince = new Date().toISOString();
    saveConfig(config);

    if (stdout.trim() === "active") {
      return `Сервис перезапущен. Статус: active`;
    } else {
      return `Сервис перезапущен, но статус: ${stdout.trim()}. Проверь логи!`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Ошибка перезапуска: ${msg}`);
  }
}

// ─── Форматирование ─────────────────────────────────────────

function formatUptime(since: string): string {
  if (!since) return "неизвестно";
  const diff = Date.now() - new Date(since).getTime();
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}д ${hours % 24}ч`;
  }
  return `${hours}ч ${minutes}м`;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function parseSystemdProps(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.trim().split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return props;
}

async function getServiceTrafficBytes(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `systemctl show ${SYSTEMD_SERVICE} --property=IPIngressBytes,IPEgressBytes 2>/dev/null`
    );
    const props = parseSystemdProps(stdout);
    const ingress = parseInt(props.IPIngressBytes || "0", 10);
    const egress = parseInt(props.IPEgressBytes || "0", 10);
    return (isNaN(ingress) ? 0 : ingress) + (isNaN(egress) ? 0 : egress);
  } catch {
    return 0;
  }
}

// ─── Гарда: только админ ────────────────────────────────────

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === ADMIN_CHAT_ID;
}

// ─── Инициализация бота ─────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

const mainKeyboard = new Keyboard()
  .text("Статус").text("Статистика").row()
  .text("Перезапуск").text("Конфиг").row()
  .text("Мониторинг")
  .resized()
  .persistent();

// Middleware: фильтруем все сообщения не от админа
bot.use(async (ctx, next) => {
  if (!isAdmin(ctx)) {
    // Молча игнорируем чужие сообщения
    return;
  }
  await next();
});

// /start — приветствие
bot.command("start", async (ctx) => {
  await ctx.reply(
    "🔧 VK TURN Proxy Monitor\n\n" +
      "Для обновления ссылки отправь её в чат.\n\n" +
      "Команды:\n" +
      "/status — проверка здоровья TURN\n" +
      "/stats — статистика\n" +
      "/restart — перезапустить vk-turn-proxy\n" +
      "/config — текущая конфигурация\n" +
      "/monitor — вкл/выкл мониторинг",
    { reply_markup: mainKeyboard }
  );
});

// /status — проверка TURN
async function handleStatus(ctx: Context): Promise<void> {
  const msg = await ctx.reply("⏳ Проверяю TURN...");

  const result = await checkTurnHealth();
  const config = loadConfig();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = result.details;
  saveConfig(config);

  const icon = result.alive ? "✅" : "❌";
  await ctx.api.editMessageText(
    ctx.chat!.id,
    msg.message_id,
    `${icon} TURN ${result.alive ? "жив" : "мёртв"}\n\n${result.details}`
  );
}
bot.command("status", handleStatus);
bot.hears("Статус", handleStatus);

// /setlink — обновление ссылки на VK-звонок
bot.command("setlink", async (ctx) => {
  const link = ctx.match?.trim();

  if (!link) {
    await ctx.reply("Использование: /setlink https://vk.com/call/join/...");
    return;
  }

  try {
    const result = await updateCallLink(link);
    const msg = await ctx.reply(`✅ ${result}\n\n⏳ Перезапускаю сервис...`);
    try {
      const restartResult = await restartService();
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `✅ ${result}\n\n✅ ${restartResult}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `✅ ${result}\n\n❌ ${errMsg}`
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ ${msg}`);
  }
});

// /restart — перезапуск сервиса
async function handleRestart(ctx: Context): Promise<void> {
  const msg = await ctx.reply("⏳ Перезапускаю vk-turn-proxy...");

  try {
    const result = await restartService();
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `✅ ${result}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `❌ ${errMsg}`
    );
  }
}
bot.command("restart", handleRestart);
bot.hears("Перезапуск", handleRestart);

// /stats — статистика
async function handleStats(ctx: Context): Promise<void> {
  const config = loadConfig();
  const s = config.stats;

  // Получаем информацию о сервисе из systemd
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
    if (mem > 0) {
      serviceState += `, ${(mem / 1024 / 1024).toFixed(1)} МБ`;
    }
  } catch {
    // Сервис может быть не установлен на этапе разработки
  }

  const lines = [
    `📊 Статистика VK TURN Proxy`,
    ``,
    `Сервис: ${serviceState}`,
    serviceUptime ? `Аптайм сервиса: ${serviceUptime}` : null,
    `Аптайм бота: ${formatUptime(s.uptimeSince)}`,
    `Перезапусков: ${s.totalRestarts}`,
    ``,
    `Последняя проверка: ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString("ru") : "—"}`,
    `Результат: ${s.lastCheckOk ? "✅ OK" : "❌ Fail"}`,
    s.lastCheckDetails ? `Детали: ${s.lastCheckDetails}` : null,
    ``,
    `Ссылка обновлена: ${config.updatedAt ? new Date(config.updatedAt).toLocaleString("ru") : "—"}`,
  ];

  await ctx.reply(lines.filter((l) => l !== null).join("\n"));
}
bot.command("stats", handleStats);
bot.hears("Статистика", handleStats);

// /config — текущая конфигурация (без секретов)
async function handleConfig(ctx: Context): Promise<void> {
  const config = loadConfig();

  // Маскируем ссылку — показываем только начало
  const maskedLink = config.vkCallLink
    ? config.vkCallLink.slice(0, 35) + "..."
    : "не задана";

  await ctx.reply(
    `⚙️ Конфигурация\n\n` +
      `VK-звонок: ${maskedLink}\n` +
      `WG peer: ${config.wgPeerAddress}:${config.wgPeerPort}\n` +
      `TURN порт: ${config.turnListenPort}\n` +
      `Интервал проверки: ${CHECK_INTERVAL_MS / 60_000} мин`
  );
}
bot.command("config", handleConfig);
bot.hears("Конфиг", handleConfig);

// /monitor — включение/отключение мониторинга
async function handleMonitor(ctx: Context): Promise<void> {
  const config = loadConfig();
  config.monitoringEnabled = !config.monitoringEnabled;
  saveConfig(config);

  const state = config.monitoringEnabled ? "включён ✅" : "выключен ⏸";
  await ctx.reply(`Мониторинг ${state}`);
}
bot.command("monitor", handleMonitor);
bot.hears("Мониторинг", handleMonitor);

// Обработка простых сообщений — автоматически применяем ссылку VK
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (/^https:\/\/vk\.(com|ru)\/call\/join\//.test(text)) {
    try {
      const result = await updateCallLink(text);
      const msg = await ctx.reply(`🔗 ${result}\n\n⏳ Перезапускаю сервис...`);
      try {
        const restartResult = await restartService();
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msg.message_id,
          `🔗 ${result}\n\n✅ ${restartResult}`
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msg.message_id,
          `🔗 ${result}\n\n❌ ${errMsg}`
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ ${errMsg}`);
    }
    return;
  }

  await ctx.reply(
    "Нераспознанная команда. Отправь новую ссылку VK-звонка или используй:\n\n" +
      "/status — проверка TURN\n" +
      "/stats — статистика\n" +
      "/restart — перезапуск сервиса\n" +
      "/config — текущая конфигурация"
  );
});

// ─── Фоновый мониторинг ─────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval>;

async function runHealthCheck(): Promise<void> {
  const config = loadConfig();

  // Не проверяем, если мониторинг выключен или ссылка не задана
  if (!config.monitoringEnabled || !config.vkCallLink) return;

  const result = await checkTurnHealth();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = result.details;

  // Записываем инцидент
  if (!result.alive) {
    config.dailyStats.failedChecks++;
    const ts = new Date().toLocaleString("ru");
    const short = result.details.split("\n")[0];
    config.dailyStats.incidents.push(`${ts} — ${short}`);
    // Ограничиваем список последними 50 записями
    if (config.dailyStats.incidents.length > 50) {
      config.dailyStats.incidents = config.dailyStats.incidents.slice(-50);
    }
  }

  saveConfig(config);

  // Алерт только если TURN упал
  if (!result.alive) {
    try {
      await bot.api.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 TURN не отвечает!\n\n${result.details}\n\n` +
          `Отправь новую ссылку VK-звонка или выполни /restart`
      );
    } catch (error) {
      console.error("Не удалось отправить алерт:", error);
    }
  }
}

function startMonitor(): void {
  console.log(
    `Мониторинг запущен, интервал: ${CHECK_INTERVAL_MS / 60_000} мин`
  );

  // Первая проверка через 30 секунд после старта
  setTimeout(() => runHealthCheck(), 30_000);

  // Далее — по расписанию
  monitorInterval = setInterval(() => runHealthCheck(), CHECK_INTERVAL_MS);
}

// ─── Ежедневный отчёт ────────────────────────────────────────

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

  // Сборка отчёта
  const lines = [
    `📋 Ежедневный отчёт VK TURN Proxy`,
    ``,
    `Статус: ${health.alive ? "✅ OK" : "❌ Fail"}`,
    `Сервис: ${serviceState}`,
    serviceUptime ? `Аптайм сервиса: ${serviceUptime}` : null,
    `Аптайм бота: ${formatUptime(config.stats.uptimeSince)}`,
    `Активные подключения: ${connCount}`,
    `Трафик за сутки: ${trafficStr}`,
    ``,
    `Происшествия: ${ds.failedChecks === 0 ? "нет ✅" : `${ds.failedChecks} ⚠️`}`,
  ];

  if (ds.incidents.length > 0) {
    const shown = ds.incidents.slice(-10);
    lines.push(...shown.map((i) => `  • ${i}`));
    if (ds.incidents.length > 10) {
      lines.push(`  ... и ещё ${ds.incidents.length - 10}`);
    }
  }

  try {
    await bot.api.sendMessage(
      ADMIN_CHAT_ID,
      lines.filter((l) => l !== null).join("\n")
    );
  } catch (error) {
    console.error("Не удалось отправить ежедневный отчёт:", error);
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

function scheduleDailyReport(): void {
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

// ─── Запуск ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("VK TURN Proxy Monitor запускается...");

  // Инициализируем конфиг и обновляем время старта бота
  const config = loadConfig();
  config.stats.uptimeSince = new Date().toISOString();
  config.dailyStats.trafficSnapshotBytes = await getServiceTrafficBytes();
  saveConfig(config);

  // Запускаем фоновый мониторинг
  startMonitor();

  // Запускаем ежедневный отчёт (04:00 UTC)
  scheduleDailyReport();

  // Запускаем бота
  bot.start({
    onStart: () => {
      console.log("Бот запущен");

      // Уведомляем админа о запуске и показываем клавиатуру
      bot.api
        .sendMessage(
          ADMIN_CHAT_ID,
          "🟢 VK TURN Monitor запущен\n\nДля обновления ссылки proxy отправь новую ссылку в чат",
          { reply_markup: mainKeyboard }
        )
        .catch(() => {});
    },
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Остановка...");
  clearInterval(monitorInterval);
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(monitorInterval);
  bot.stop();
  process.exit(0);
});

main().catch(console.error);
