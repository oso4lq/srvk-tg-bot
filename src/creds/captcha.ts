// src/creds/captcha.ts

import { InlineKeyboard } from "grammy";
import { bot } from "../bot";
import { ADMIN_CHAT_IDS } from "../utils/notify";

// ─── Обработка капчи через Telegram ─────────────────────────

const CAPTCHA_TIMEOUT_MS = 180_000; // 3 минуты (интерактивная капча)

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
 * Отправляет ссылку на капчу админам и ждёт подтверждение.
 * Для интерактивной капчи VK (redirect_uri) — пользователь решает в браузере
 * и нажимает «Готово». Возвращает пустую строку при подтверждении.
 * Бросает ошибку при таймауте (3 мин).
 */
export async function requestCaptchaSolution(
  redirectUri: string,
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
          .sendMessage(chatId, "⏰ Таймаут капчи (3 мин). Credentials не получены.")
          .catch(() => {});
      }
      reject(new Error("Таймаут капчи (3 мин)"));
    }, CAPTCHA_TIMEOUT_MS);

    pending = { resolve, reject, timeout };

    // Отправляем ссылку на капчу и кнопку «Готово»
    sendCaptchaToAdmins(redirectUri).catch((err) => {
      console.error("Ошибка отправки капчи:", err);
    });
  });
}

/** Принимает подтверждение решения капчи. Возвращает true если была ожидающая капча. */
export function submitCaptchaAnswer(answer: string): boolean {
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pending.resolve(answer);
  pending = null;
  return true;
}

// ─── Отправка ссылки на капчу ────────────────────────────────

async function sendCaptchaToAdmins(redirectUri: string): Promise<void> {
  const keyboard = new InlineKeyboard()
    .url("Пройти капчу", redirectUri)
    .text("Готово", "captcha:done");

  const text =
    "🔐 VK требует капчу для TURN credentials\n\n" +
    "Открой ссылку, реши капчу, затем нажми «Готово» (3 мин):";

  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (err) {
      console.error(`Ошибка отправки капчи в ${chatId}:`, err);
    }
  }
}
