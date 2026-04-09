// src/creds/vk-creds.ts

import { randomUUID } from "crypto";
import { requestCaptchaSolution } from "./captcha";
import { notifyAdmins } from "../utils/notify";

// ─── Типы ────────────────────────────────────────────────────

export interface TurnCreds {
  username: string;
  password: string;
  turnServer: string;
}

interface VkApiError {
  error_code: number;
  error_msg: string;
  captcha_sid?: string;
  captcha_img?: string;
  redirect_uri?: string;
}

/** Сигнал: интерактивная капча решена, нужен перезапуск всей цепочки */
class CaptchaSolvedError extends Error {
  constructor() {
    super("Капча решена, перезапуск цепочки");
  }
}

// ─── Константы VK API ────────────────────────────────────────

const VK_CLIENT_ID = "6287487";
const VK_CLIENT_SECRET = "QbYic1K3lEV5kTGiqlq2";
const VK_APP_KEY = "CGMMEJLGDIHBABABA";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

// ─── Кэш credentials ────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут
let cache: { creds: TurnCreds; link: string; expiresAt: number } | null = null;
let fetchPromise: Promise<TurnCreds> | null = null;

// ─── Публичный API ───────────────────────────────────────────

/** Извлекает токен ссылки из полного URL (часть после /join/) */
export function extractLinkToken(url: string): string {
  const parts = url.split("/");
  let token = parts[parts.length - 1];
  const idx = token.search(/[?#]/);
  if (idx !== -1) token = token.substring(0, idx);
  return token;
}

/**
 * Получает TURN credentials для ссылки.
 * Кэширует результат на 5 минут. При капче — запрашивает через Telegram.
 * Дедуплицирует параллельные запросы (все ждут один fetch).
 */
export async function getCreds(linkToken: string): Promise<TurnCreds> {
  // Проверяем кэш
  if (cache && cache.link === linkToken && Date.now() < cache.expiresAt) {
    return cache.creds;
  }

  // Если уже идёт запрос — ждём его результат
  if (fetchPromise) return fetchPromise;

  // Новый запрос
  fetchPromise = fetchCredsWithRetry(linkToken)
    .then((creds) => {
      cache = { creds, link: linkToken, expiresAt: Date.now() + CACHE_TTL_MS };
      fetchPromise = null;
      return creds;
    })
    .catch((err) => {
      fetchPromise = null;
      throw err;
    });

  return fetchPromise;
}

/** Сбрасывает кэш credentials */
export function invalidateCredsCache(): void {
  cache = null;
}

// ─── HTTP-запросы к VK API ───────────────────────────────────

async function vkPost(url: string, data: string): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: data,
  });
  return (await res.json()) as Record<string, any>;
}

// ─── 4-step цепочка с перезапуском после капчи ───────────────

/**
 * Пробует получить credentials. Если VK потребовал интерактивную капчу
 * и пользователь её решил — перезапускает всю цепочку с нуля
 * (VK разблокирует IP для НОВЫХ запросов, а не для повторов).
 */
async function fetchCredsWithRetry(linkToken: string): Promise<TurnCreds> {
  try {
    return await fetchCreds(linkToken);
  } catch (err) {
    if (err instanceof CaptchaSolvedError) {
      console.log("Капча решена, перезапускаю получение credentials...");
      notifyAdmins("🔄 Капча решена, получаю credentials...").catch(() => {});
      return fetchCreds(linkToken);
    }
    throw err;
  }
}

async function fetchCreds(linkToken: string): Promise<TurnCreds> {
  // Шаг 1: Anonymous token (login.vk.ru)
  const step1 = await vkPost(
    "https://login.vk.ru/?act=get_anonym_token",
    `client_id=${VK_CLIENT_ID}&token_type=messages&client_secret=${VK_CLIENT_SECRET}&version=1&app_id=${VK_CLIENT_ID}`,
  );

  const token1: string | undefined = step1?.data?.access_token;
  if (!token1) {
    throw new Error(
      `Шаг 1 (anonym token): неожиданный ответ: ${JSON.stringify(step1).substring(0, 200)}`,
    );
  }

  // Шаг 2: Call token (может потребовать капчу)
  const token2 = await getCallToken(linkToken, token1);

  // Шаг 3: Session key (OK.ru API)
  const sessionData = JSON.stringify({
    version: 2,
    device_id: randomUUID(),
    client_version: 1.1,
    client_type: "SDK_JS",
  });

  const step3 = await vkPost(
    "https://calls.okcdn.ru/fb.do",
    `session_data=${encodeURIComponent(sessionData)}&method=auth.anonymLogin&format=JSON&application_key=${VK_APP_KEY}`,
  );

  const token3: string | undefined = step3?.session_key;
  if (!token3) {
    throw new Error(
      `Шаг 3 (session key): неожиданный ответ: ${JSON.stringify(step3).substring(0, 200)}`,
    );
  }

  // Шаг 4: TURN credentials
  const step4 = await vkPost(
    "https://calls.okcdn.ru/fb.do",
    `joinLink=${linkToken}&isVideo=false&protocolVersion=5&anonymToken=${token2}` +
      `&method=vchat.joinConversationByLink&format=JSON&application_key=${VK_APP_KEY}&session_key=${token3}`,
  );

  const turnServer = step4?.turn_server;
  if (!turnServer?.username || !turnServer?.credential || !turnServer?.urls?.[0]) {
    throw new Error(
      `Шаг 4 (TURN creds): неожиданный ответ: ${JSON.stringify(step4).substring(0, 200)}`,
    );
  }

  // Парсим адрес TURN-сервера: "turn:host:port?transport=udp" → "host:port"
  const rawUrl: string = turnServer.urls[0];
  const clean = rawUrl.split("?")[0];
  const address = clean.replace(/^turns?:/, "");

  console.log(`TURN credentials получены для ${linkToken.substring(0, 8)}...`);

  return {
    username: turnServer.username,
    password: turnServer.credential,
    turnServer: address,
  };
}

// ─── Шаг 2 с обработкой капчи ───────────────────────────────

async function getCallToken(linkToken: string, accessToken: string): Promise<string> {
  const body =
    `vk_join_link=https://vk.com/call/join/${linkToken}&name=123&access_token=${accessToken}`;

  const resp = await vkPost(
    `https://api.vk.ru/method/calls.getAnonymousToken?v=5.274&client_id=${VK_CLIENT_ID}`,
    body,
  );

  // Успех
  if (resp?.response?.token) {
    return resp.response.token as string;
  }

  // Капча
  const err = resp?.error as VkApiError | undefined;
  if (err?.error_code === 14 && err.captcha_sid) {
    const captchaUrl = err.redirect_uri || err.captcha_img;
    if (!captchaUrl) {
      throw new Error(`Шаг 2: капча без URL (sid=${err.captcha_sid})`);
    }
    console.log("VK API требует капчу");

    // Ждём решения от пользователя
    await requestCaptchaSolution(captchaUrl);

    // Интерактивная капча решена — перезапускаем всю цепочку
    throw new CaptchaSolvedError();
  }

  // Другая ошибка VK API
  throw new Error(
    `Шаг 2 (call token): ${err?.error_msg || JSON.stringify(resp).substring(0, 200)}`,
  );
}
