import { Context } from "grammy";
import { bot } from "../bot";

// ─── Гарда и уведомления ────────────────────────────────────

export const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_ID || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => !isNaN(n) && n !== 0);

export function isAdmin(ctx: Context): boolean {
  return ctx.from?.id !== undefined && ADMIN_CHAT_IDS.includes(ctx.from.id);
}

/** Отправляет сообщение всем админам */
export async function notifyAdmins(text: string, extra?: object): Promise<void> {
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      await bot.api.sendMessage(chatId, text, extra);
    } catch (error) {
      console.error(`Не удалось отправить сообщение ${chatId}:`, error);
    }
  }
}
