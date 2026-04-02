// src/bot.ts

import { Bot, Keyboard } from "grammy";
import "dotenv/config";

// ─── Инициализация бота ─────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN!;

export const bot = new Bot(BOT_TOKEN);

export const mainKeyboard = new Keyboard()
  .text("Статус").text("Статистика").row()
  .text("Перезапуск").text("Конфиг").row()
  .text("Мониторинг")
  .resized()
  .persistent();
