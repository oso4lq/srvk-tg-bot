// src/creds/captcha.ts

import { InputFile } from "grammy";
import { bot } from "../bot";
import { ADMIN_CHAT_IDS } from "../utils/notify";

// ─── Обработка капчи через Telegram ─────────────────────────

const CAPTCHA_TIMEOUT_MS = 120_000; // 2 минуты

interface PendingCaptcha {
  resolve: (key: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let pending: PendingCaptcha | null = null;

/** Есть ли ожидающая капча */
export function hasPendingCaptcha(): boolean {
  return pending !== null;
}

/**
 * Отправляет капчу админам в Telegram и ждёт текстовый ответ.
 * Возвращает введённый текст капчи.
 * Бросает ошибку при таймауте (2 мин).
 */
export async function requestCaptchaSolution(
  captchaImg: string,
  _captchaSid: string,
): Promise<string> {
  // Если есть предыдущая — отменяем
  if (pending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Перезаписана новой капчей"));
    pending = null;
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending = null;
      for (const chatId of ADMIN_CHAT_IDS) {
        bot.api
          .sendMessage(chatId, "⏰ Таймаут капчи (2 мин). Credentials не получены.")
          .catch(() => {});
      }
      reject(new Error("Таймаут ввода капчи (2 мин)"));
    }, CAPTCHA_TIMEOUT_MS);

    pending = { resolve, reject, timeout };

    // Отправляем картинку капчи админам
    sendCaptchaToAdmins(captchaImg).catch((err) => {
      console.error("Ошибка отправки капчи:", err);
    });
  });
}

/** Принимает ответ на капчу. Возвращает true если была ожидающая капча. */
export function submitCaptchaAnswer(answer: string): boolean {
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pending.resolve(answer);
  pending = null;
  return true;
}

// ─── Отправка картинки капчи ─────────────────────────────────

async function sendCaptchaToAdmins(captchaImg: string): Promise<void> {
  const caption = "🔐 VK требует капчу для TURN credentials\nОтветь текстом с картинки (2 мин):";

  try {
    // Скачиваем картинку (VK может фильтровать по заголовкам)
    const res = await fetch(captchaImg, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
      },
    });
    const buffer = Buffer.from(await res.arrayBuffer());

    for (const chatId of ADMIN_CHAT_IDS) {
      try {
        const inputFile = new InputFile(buffer, "captcha.png");
        await bot.api.sendPhoto(chatId, inputFile, { caption });
      } catch (err) {
        console.error(`Ошибка отправки капчи в ${chatId}:`, err);
      }
    }
  } catch {
    // Не удалось скачать картинку — отправляем ссылку текстом
    for (const chatId of ADMIN_CHAT_IDS) {
      bot.api
        .sendMessage(chatId, `${caption}\n\nСсылка на капчу: ${captchaImg}`)
        .catch(() => {});
    }
  }
}
