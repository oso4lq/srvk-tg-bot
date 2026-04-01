/**
 * email.ts — Мониторинг Yandex-почты через IMAP
 *
 * Периодически опрашивает INBOX на непрочитанные письма,
 * извлекает VK call ссылки и передаёт в основной flow бота.
 * Обработанные письма перемещаются в папку "Processed".
 */

import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";

// ─── Конфигурация ───────────────────────────────────────────

const YANDEX_MAIL_USER = process.env.YANDEX_MAIL_USER || "";
const YANDEX_MAIL_PASSWORD = process.env.YANDEX_MAIL_PASSWORD || "";
const YANDEX_MAIL_FROM_FILTER = process.env.YANDEX_MAIL_FROM_FILTER || "";
const YANDEX_MAIL_CHECK_INTERVAL = Number(process.env.YANDEX_MAIL_CHECK_INTERVAL) || 60;

/** Папка для обработанных писем (создаётся автоматически) */
const PROCESSED_FOLDER = "Processed";

/** Regex для извлечения VK call ссылки (тот же, что в index.ts) */
const VK_CALL_REGEX = /https:\/\/vk\.(com|ru)\/call\/join\/[A-Za-z0-9_/-]+/g;

/** Проверяет, настроена ли почта */
export function isEmailConfigured(): boolean {
  return !!(YANDEX_MAIL_USER && YANDEX_MAIL_PASSWORD);
}

// ─── Типы ───────────────────────────────────────────────────

/** Колбэк для обработки найденной ссылки */
export type OnLinkFound = (link: string, fromAddress: string) => Promise<void>;

/** Колбэк для уведомления админов */
export type OnNotify = (message: string) => Promise<void>;

interface EmailMonitorCallbacks {
  onLinkFound: OnLinkFound;
  onNotify: OnNotify;
}

// ─── IMAP-клиент ────────────────────────────────────────────

function createImapClient(): ImapFlow {
  return new ImapFlow({
    host: "imap.yandex.ru",
    port: 993,
    secure: true,
    auth: {
      user: YANDEX_MAIL_USER,
      pass: YANDEX_MAIL_PASSWORD,
    },
    logger: false, // Отключаем встроенное логирование ImapFlow
  });
}

/**
 * Создаёт папку Processed, если её ещё нет.
 * Вызывается один раз при старте.
 */
async function ensureProcessedFolder(client: ImapFlow): Promise<void> {
  try {
    const mailboxes = await client.list();
    const exists = mailboxes.some(
      (mb) => mb.path === PROCESSED_FOLDER || mb.name === PROCESSED_FOLDER
    );
    if (!exists) {
      await client.mailboxCreate(PROCESSED_FOLDER);
      console.log(`[Email] Создана папка "${PROCESSED_FOLDER}"`);
    }
  } catch (error) {
    console.error("[Email] Ошибка создания папки Processed:", error);
  }
}

/**
 * Извлекает все VK call ссылки из текста письма.
 * Ищет и в plain text, и в HTML.
 */
function extractVkLinks(parsed: ParsedMail): string[] {
  const links = new Set<string>();

  const sources = [parsed.text || "", parsed.html || ""];

  for (const source of sources) {
    const matches = source.match(VK_CALL_REGEX);
    if (matches) {
      for (const match of matches) {
        links.add(match);
      }
    }
  }

  return [...links];
}

/**
 * Извлекает адрес отправителя из заголовков письма.
 */
function getFromAddress(parsed: ParsedMail): string {
  if (parsed.from?.value?.[0]?.address) {
    return parsed.from.value[0].address;
  }
  return "неизвестный";
}

/**
 * Проверяет, подходит ли отправитель под фильтр.
 * Если фильтр пустой — пропускает всех.
 */
function isAllowedSender(fromAddress: string): boolean {
  if (!YANDEX_MAIL_FROM_FILTER) return true;

  const allowed = YANDEX_MAIL_FROM_FILTER
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return allowed.includes(fromAddress.toLowerCase());
}

// ─── Основной цикл опроса ───────────────────────────────────

/**
 * Выполняет одну итерацию проверки почты:
 * 1. Подключается к IMAP
 * 2. Ищет непрочитанные письма в INBOX
 * 3. Извлекает VK call ссылки
 * 4. Вызывает колбэк для каждой найденной ссылки
 * 5. Перемещает обработанные письма в Processed
 * 6. Отключается
 */
async function pollOnce(callbacks: EmailMonitorCallbacks): Promise<void> {
  const client = createImapClient();

  try {
    await client.connect();

    // Создаём папку при первом запуске (idempotent)
    await ensureProcessedFolder(client);

    // Открываем INBOX
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Ищем непрочитанные письма
      const uids = await client.search({ seen: false }, { uid: true });

      if (uids.length === 0) return;

      console.log(`[Email] Найдено ${uids.length} непрочитанных писем`);

      for (const uid of uids) {
        try {
          // Скачиваем письмо целиком
          const rawMessage = await client.download(String(uid), undefined, { uid: true });

          // Парсим MIME
          const chunks: Buffer[] = [];
          for await (const chunk of rawMessage.content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const fullBuffer = Buffer.concat(chunks);
          const parsed = await simpleParser(fullBuffer);

          const fromAddress = getFromAddress(parsed);

          // Проверяем фильтр по отправителю
          if (!isAllowedSender(fromAddress)) {
            console.log(`[Email] Пропущено письмо от ${fromAddress} (не в фильтре)`);
            // Помечаем прочитанным, но не перемещаем
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          // Извлекаем ссылки
          const links = extractVkLinks(parsed);

          if (links.length === 0) {
            console.log(`[Email] Письмо от ${fromAddress}: VK-ссылок не найдено`);
            // Помечаем прочитанным, но не перемещаем
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            continue;
          }

          console.log(`[Email] Письмо от ${fromAddress}: найдено ${links.length} ссылок`);

          // Обрабатываем каждую найденную ссылку
          for (const link of links) {
            try {
              await callbacks.onLinkFound(link, fromAddress);
            } catch (error) {
              console.error(`[Email] Ошибка обработки ссылки ${link}:`, error);
            }
          }

          // Перемещаем письмо в Processed
          try {
            await client.messageMove(String(uid), PROCESSED_FOLDER, { uid: true });
          } catch (moveError) {
            // Если переместить не удалось — хотя бы помечаем прочитанным
            console.error("[Email] Ошибка перемещения письма:", moveError);
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          }
        } catch (msgError) {
          console.error(`[Email] Ошибка обработки письма UID=${uid}:`, msgError);
          // Помечаем прочитанным, чтобы не застрять на битом письме
          try {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          } catch {}
        }
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    console.error("[Email] Ошибка подключения к IMAP:", error);
    // Не кидаем дальше — следующая итерация попробует снова
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

// ─── Запуск и остановка ─────────────────────────────────────

let pollInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

/**
 * Запускает фоновый мониторинг почты.
 * Вызывается из main() в index.ts.
 */
export function startEmailMonitor(callbacks: EmailMonitorCallbacks): void {
  if (!isEmailConfigured()) {
    console.log("[Email] Мониторинг почты не настроен — пропущено");
    return;
  }

  const intervalMs = YANDEX_MAIL_CHECK_INTERVAL * 1000;

  console.log(
    `[Email] Мониторинг запущен: ${YANDEX_MAIL_USER}, ` +
      `интервал ${YANDEX_MAIL_CHECK_INTERVAL}с, ` +
      `фильтр: ${YANDEX_MAIL_FROM_FILTER || "все отправители"}`
  );

  // Первая проверка через 10 секунд после старта
  setTimeout(async () => {
    await safePoll(callbacks);
  }, 10_000);

  // Регулярная проверка
  pollInterval = setInterval(async () => {
    await safePoll(callbacks);
  }, intervalMs);
}

/** Обёртка для предотвращения параллельных опросов */
async function safePoll(callbacks: EmailMonitorCallbacks): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    await pollOnce(callbacks);
  } catch (error) {
    console.error("[Email] Непредвиденная ошибка:", error);
  } finally {
    isPolling = false;
  }
}

/** Останавливает мониторинг (для graceful shutdown) */
export function stopEmailMonitor(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[Email] Мониторинг остановлен");
  }
}
