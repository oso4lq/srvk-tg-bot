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
  /** Очередь резервных VK call ссылок */
  linkQueue: string[];
}

const BOT_TOKEN = process.env.BOT_TOKEN!;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => !isNaN(n) && n !== 0);
const CONFIG_PATH = process.env.CONFIG_PATH || "/etc/vk-turn-proxy/config.json";
const SYSTEMD_SERVICE = process.env.SYSTEMD_SERVICE || "vk-turn-proxy";
const VK_TURN_CLIENT_PATH = process.env.VK_TURN_CLIENT_PATH || "/usr/local/bin/vk-turn-client";
const VPS_PUBLIC_IP = process.env.VPS_PUBLIC_IP || "";
// CHECK_INTERVAL_MIN больше не используется — интервал рандомизирован (5–10 мин)

// VK API для публикации ссылки на стену закрытой группы
const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || "";
const VK_GROUP_ID = process.env.VK_GROUP_ID || "";
const isVkConfigured = !!(VK_GROUP_TOKEN && VK_GROUP_ID);

let isApplying = false;

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

function saveConfig(config: TurnConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── VK API ─────────────────────────────────────────────────

/** Публикует ссылку новым постом на стене закрытой VK-группы */
async function publishToVk(link: string): Promise<{ ok: boolean; error?: string }> {
  if (!isVkConfigured) {
    return { ok: false, error: "Публикация в VK не настроена" };
  }

  try {
    const params = new URLSearchParams({
      access_token: VK_GROUP_TOKEN,
      owner_id: `-${VK_GROUP_ID}`,
      from_group: "1",
      message: link,
      v: "5.199",
    });

    const res = await fetch("https://api.vk.com/method/wall.post", {
      method: "POST",
      body: params,
    });

    const data = await res.json() as {
      response?: { post_id: number };
      error?: { error_code: number; error_msg: string };
    };

    if (data.error) {
      const { error_code, error_msg } = data.error;
      return { ok: false, error: `VK API ${error_code}: ${error_msg}` };
    }

    if (data.response?.post_id) {
      return { ok: true };
    }

    return { ok: false, error: "VK API: неожиданный ответ" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `VK API: ${msg}` };
  }
}

/** Проверяет валидность VK call link через TURN-клиент (до maxAttempts попыток) */
async function checkLinkHealth(
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

// ─── Применение ссылки ──────────────────────────────────────

const VK_CALL_REGEX = /^https:\/\/vk\.(com|ru)\/call\/join\/[A-Za-z0-9_/-]+$/;

/** Применяет ссылку: валидация → сохранение → VK → health check → отчёт */
async function applyLink(link: string, ctx: Context): Promise<void> {
  if (isApplying) {
    await ctx.reply("⏳ Уже применяю ссылку, подожди.");
    return;
  }

  if (!VK_CALL_REGEX.test(link)) {
    await ctx.reply("❌ Неверный формат ссылки. Ожидается: https://vk.com/call/join/...");
    return;
  }

  const config = loadConfig();
  if (link === config.vkCallLink) {
    await ctx.reply("ℹ️ Эта ссылка уже активна.");
    return;
  }

  isApplying = true;
  const statusMsg = await ctx.reply("⏳ Применяю ссылку...");
  const chatId = ctx.chat!.id;

  const updateStatus = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, statusMsg.message_id, text);
    } catch {
      // Telegram может отклонить edit если текст не изменился
    }
  };

  try {
    // Шаг 1: сохранение в конфиг
    try {
      config.vkCallLink = link;
      config.updatedAt = new Date().toISOString();
      saveConfig(config);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateStatus(`❌ Не удалось сохранить конфиг: ${msg}`);
      return;
    }

    // Шаг 2: публикация в VK
    let vkStatus = "";
    await updateStatus("⏳ Ссылка сохранена. Публикую в VK...");

    const vkResult = await publishToVk(link);
    if (vkResult.ok) {
      vkStatus = "VK обновлён";
    } else if (!isVkConfigured) {
      vkStatus = "VK relay не настроен";
    } else {
      vkStatus = `VK: ${vkResult.error}`;
    }

    // Шаг 3: health check с retries
    const healthResult = await checkLinkHealth(link, config, async (attempt) => {
      await updateStatus(`⏳ ${vkStatus}. Проверяю TURN (${attempt}/5)...`);
    });

    // Шаг 4: финальный отчёт
    const parts: string[] = [];

    if (healthResult.alive) {
      parts.push("✅ Ссылка применена, TURN жив");
    } else {
      parts.push(`⚠️ Ссылка сохранена, но TURN не отвечает (${healthResult.attempts}/5 попыток)`);
    }
    parts.push(vkStatus);

    if (healthResult.error && healthResult.alive) {
      parts.push(healthResult.error);
    }

    config.stats.lastCheckOk = healthResult.alive;
    config.stats.lastCheckAt = new Date().toISOString();
    config.stats.lastCheckDetails = healthResult.alive
      ? `Ссылка проверена, ${healthResult.attempts} попыток`
      : healthResult.error || "TURN не отвечает";
    saveConfig(config);

    await updateStatus(parts.join("\n"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await updateStatus(`❌ Ошибка: ${msg}`);
  } finally {
    isApplying = false;
  }
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

/**
 * Перебирает linkQueue, ищет живую ссылку для замены мёртвой активной.
 * Мёртвые ссылки удаляются из очереди. Живая активируется и постится в VK.
 * Возвращает true если fallback удался.
 */
async function tryFallbackFromQueue(): Promise<boolean> {
  if (isApplying) return false;
  isApplying = true;

  try {
    const config = loadConfig();
    const deadLink = config.vkCallLink;
    let activated = false;

    // При splice без инкремента i — следующий элемент сдвигается на текущий индекс
    let i = 0;
    while (i < config.linkQueue.length) {
      const candidate = config.linkQueue[i];

      // Пропускаем ссылку, совпадающую с текущей активной
      if (candidate === deadLink) {
        i++;
        continue;
      }

      const result = await checkLinkHealth(candidate, config, undefined, 2, 10_000);

      if (result.alive) {
        // Активируем
        config.vkCallLink = candidate;
        config.updatedAt = new Date().toISOString();
        config.stats.lastCheckOk = true;
        config.stats.lastCheckAt = new Date().toISOString();
        config.stats.lastCheckDetails = `Fallback: переключение на резервную ссылку`;
        saveConfig(config);

        // Публикуем в VK (не фатально при ошибке)
        const vkResult = await publishToVk(candidate);
        const vkNote = vkResult.ok ? "" : `\n⚠️ VK: ${vkResult.error}`;

        await notifyAdmins(
          `🔄 Ссылка умерла, переключился на резервную\n` +
            `Новая: ${candidate}\n` +
            `Ссылок в очереди: ${config.linkQueue.length}${vkNote}`
        );

        activated = true;
        break;
      } else {
        // Мёртвая — удаляем из очереди
        config.linkQueue.splice(i, 1);
        saveConfig(config);

        await notifyAdmins(
          `❌ Резервная ссылка мертва, удалена:\n${candidate}`
        );
        // Не увеличиваем i — следующий элемент сдвинулся на текущий индекс
      }
    }

    if (!activated) {
      // Удаляем из очереди ссылку, совпадающую с мёртвой активной (если есть)
      config.linkQueue = config.linkQueue.filter((l) => l !== deadLink);
      saveConfig(config);

      await notifyAdmins(
        `🚨 Все ссылки мертвы!\n` +
          `Очередь пуста, валидных ссылок нет.\n` +
          `Отправь новые ссылки в чат.`
      );
    }

    return activated;
  } finally {
    isApplying = false;
  }
}

// ─── Управление сервисом ────────────────────────────────────

/** Перезапускает vk-turn-proxy сервис (простой restart без override) */
async function restartService(): Promise<string> {
  try {
    await execAsync(`systemctl restart ${SYSTEMD_SERVICE}`);

    // Ждём 3 секунды и проверяем
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { stdout } = await execAsync(
      `systemctl is-active ${SYSTEMD_SERVICE}`
    );

    const config = loadConfig();
    config.stats.totalRestarts++;
    config.stats.uptimeSince = new Date().toISOString();
    saveConfig(config);

    if (stdout.trim() === "active") {
      return "Сервис перезапущен. Статус: active";
    }
    return `Сервис перезапущен, но статус: ${stdout.trim()}. Проверь логи!`;
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
  return ctx.from?.id !== undefined && ADMIN_CHAT_IDS.includes(ctx.from.id);
}

/** Отправляет сообщение всем админам */
async function notifyAdmins(text: string, extra?: object): Promise<void> {
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(chatId, text, extra);
    } catch (error) {
      console.error(`Не удалось отправить сообщение ${chatId}:`, error);
    }
  }
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
      "Отправь ссылку в чат — она добавится в очередь резервных.\n" +
      "Для принудительной активации: /setlink <url>\n\n" +
      "Команды:\n" +
      "/status — проверка здоровья TURN\n" +
      "/stats — статистика\n" +
      "/links — очередь резервных ссылок\n" +
      "/rmlink N — удалить ссылку из очереди\n" +
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

// /setlink — применение ссылки на VK-звонок
bot.command("setlink", async (ctx) => {
  const link = ctx.match?.trim();

  if (!link) {
    await ctx.reply("Использование: /setlink https://vk.com/call/join/...");
    return;
  }

  await applyLink(link, ctx);
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
      `Интервал проверки: 5–10 мин (рандом)`
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

// /links — просмотр очереди резервных ссылок
bot.command("links", async (ctx) => {
  const config = loadConfig();

  const lines: string[] = [];

  if (config.vkCallLink) {
    lines.push(`🔗 Активная: ${config.vkCallLink}`);
  } else {
    lines.push("🔗 Активная ссылка не задана");
  }

  if (config.linkQueue.length === 0) {
    lines.push("\nОчередь пуста, резервных ссылок нет.");
  } else {
    lines.push(`\nОчередь (${config.linkQueue.length}):`);
    config.linkQueue.forEach((link, i) => {
      lines.push(`${i + 1}. ${link}`);
    });
  }

  await ctx.reply(lines.join("\n"));
});

// /rmlink N — удаление ссылки из очереди по номеру
bot.command("rmlink", async (ctx) => {
  const arg = ctx.match?.trim();
  const num = Number(arg);

  if (!arg || isNaN(num) || !Number.isInteger(num)) {
    await ctx.reply("Использование: /rmlink N (номер из /links)");
    return;
  }

  const config = loadConfig();
  const idx = num - 1;

  if (idx < 0 || idx >= config.linkQueue.length) {
    await ctx.reply(
      `❌ Номер должен быть от 1 до ${config.linkQueue.length}.\n` +
        `Используй /links для просмотра очереди.`
    );
    return;
  }

  const removed = config.linkQueue.splice(idx, 1)[0];
  saveConfig(config);

  await ctx.reply(
    `✅ Ссылка #${num} удалена.\n${removed}\n\nОсталось в очереди: ${config.linkQueue.length}`
  );
});

// Обработка текстовых сообщений — добавление в очередь
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (VK_CALL_REGEX.test(text)) {
    // Добавляем в очередь, не активируем
    const config = loadConfig();

    if (text === config.vkCallLink) {
      await ctx.reply("ℹ️ Эта ссылка уже активна.");
      return;
    }

    if (config.linkQueue.includes(text)) {
      await ctx.reply("ℹ️ Эта ссылка уже в очереди.");
      return;
    }

    config.linkQueue.push(text);
    saveConfig(config);

    await ctx.reply(
      `✅ Ссылка добавлена в очередь (позиция ${config.linkQueue.length}).\n` +
        `Всего ссылок в очереди: ${config.linkQueue.length}`
    );
    return;
  }

  await ctx.reply("Неизвестная команда. Отправь /start для списка команд.");
});

// ─── Фоновый мониторинг ─────────────────────────────────────

let monitorTimeout: ReturnType<typeof setTimeout>;

async function runHealthCheck(): Promise<void> {
  const config = loadConfig();

  if (!config.monitoringEnabled || !config.vkCallLink) return;

  const result = await checkTurnHealth();

  config.stats.lastCheckOk = result.alive;
  config.stats.lastCheckAt = new Date().toISOString();
  config.stats.lastCheckDetails = result.details;

  if (!result.alive) {
    config.dailyStats.failedChecks++;
    const ts = new Date().toLocaleString("ru");
    const short = result.details.split("\n")[0];
    config.dailyStats.incidents.push(`${ts} — ${short}`);
    if (config.dailyStats.incidents.length > 50) {
      config.dailyStats.incidents = config.dailyStats.incidents.slice(-50);
    }
    saveConfig(config);

    // Пробуем fallback из очереди
    const fallbackOk = await tryFallbackFromQueue();

    if (!fallbackOk) {
      await notifyAdmins(
        `🚨 TURN не отвечает!\n\n${result.details}\n\n` +
          `Отправь новую ссылку VK-звонка`
      );
    }
    return;
  }

  saveConfig(config);
}

/** Случайный интервал 5–10 минут, избегая кратных 30 000 мс */
function randomCheckInterval(): number {
  const minMs = 5 * 60 * 1000;
  const maxMs = 10 * 60 * 1000;
  let ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  while (ms % 30000 === 0) {
    ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  }
  return ms;
}

function startMonitor(): void {
  console.log("Мониторинг запущен (рандомный интервал 5–10 мин)");

  // Первая проверка через 30 секунд после старта
  monitorTimeout = setTimeout(async function scheduleNext() {
    await runHealthCheck();
    const nextInterval = randomCheckInterval();
    monitorTimeout = setTimeout(scheduleNext, nextInterval);
  }, 30_000);
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
    `Ссылок в очереди: ${config.linkQueue.length}`,
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

  await notifyAdmins(lines.filter((l) => l !== null).join("\n"));

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

  // Проверка VK relay конфигурации
  if (!isVkConfigured) {
    const hasAny = VK_GROUP_TOKEN || VK_GROUP_ID;
    if (hasAny) {
      console.warn("VK relay частично настроен — нужны оба: VK_GROUP_TOKEN, VK_GROUP_ID");
    } else {
      console.log("VK relay не настроен — публикация ссылок в VK отключена");
    }
  }

  // Запускаем фоновый мониторинг
  startMonitor();

  // Запускаем ежедневный отчёт (04:00 UTC)
  scheduleDailyReport();

  // Запускаем бота
  bot.start({
    onStart: async () => {
      console.log("Бот запущен");

      // Fallback при старте: проверяем активную ссылку ДО отправки уведомления
      try {
        const preConfig = loadConfig();
        if (preConfig.vkCallLink && preConfig.linkQueue.length > 0) {
          const health = await checkLinkHealth(preConfig.vkCallLink, preConfig, undefined, 2, 10_000);
          if (!health.alive) {
            await tryFallbackFromQueue();
          }
        }
      } catch (err) {
        console.error("Startup fallback failed:", err);
      }

      // Уведомление о запуске (после fallback — актуальные данные)
      const startConfig = loadConfig();
      const monitorState = startConfig.monitoringEnabled ? "✅" : "⏸ выключен";
      const vkState = isVkConfigured ? "✅" : "выключена";
      const queueCount = startConfig.linkQueue.length;
      const queueLine = queueCount > 0
        ? `Ссылок в очереди: ${queueCount}`
        : "Очередь пуста";

      notifyAdmins(
        `🟢 VK TURN Monitor запущен\n\nМониторинг: ${monitorState}\nПубликация в VK: ${vkState}\n${queueLine}\n\nДля обновления ссылки отправь её в чат`,
        { reply_markup: mainKeyboard }
      ).catch(() => {});
    },
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Остановка...");
  clearTimeout(monitorTimeout);
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearTimeout(monitorTimeout);
  bot.stop();
  process.exit(0);
});

main().catch(console.error);
