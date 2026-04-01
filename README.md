# VK TURN Proxy Monitor

Telegram-бот для мониторинга и управления vk-turn-proxy на VPS.

## Что делает

- Проверяет здоровье TURN-соединения каждые 5 минут (сервис + UDP-порт + проверка ссылки клиентом)
- Отправляет алерт в Telegram с описанием причины, если TURN перестал отвечать
- Позволяет обновить ссылку на VK-звонок через бота (поддерживает vk.com и vk.ru)
- Перезапускает vk-turn-proxy через бота
- Показывает статистику: аптайм сервиса и бота, количество перезапусков, детали последней проверки
- Отправляет ежедневный отчёт в 04:00 UTC: статус, подключения, трафик, происшествия за сутки

## Требования

- VPS с Debian 12 (или другой Linux)
- Node.js 20+
- Установленные на VPS: WireGuard, vk-turn-proxy server
- (Опционально) vk-turn-client на VPS — для проверки ссылки через loopback-тест
- Telegram-аккаунт

## Установка с нуля

### 1. Установить Node.js (если нет)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v && npm -v
```

### 2. Установить git (если нет)

```bash
apt install -y git
```

### 3. Клонировать репозиторий

```bash
cd /opt
git clone https://github.com/oso4lq/srvk-tg-bot.git vk-turn-bot
cd /opt/vk-turn-bot
```

### 4. Установить зависимости и собрать

```bash
npm install
npm run build
```

Успешная сборка — `tsc` без ошибок, появляется папка `dist/`.

### 5. Создать Telegram-бота

1. Открыть Telegram, найти [@BotFather](https://t.me/BotFather)
2. Отправить `/newbot`
3. Ввести имя бота (например, `VK TURN Monitor`)
4. Ввести username бота (например, `vk_turn_monitor_bot`)
5. Скопировать токен — строка вида `8210090927:AAH...`

### 6. Узнать свой chat ID

1. Открыть Telegram, найти [@userinfobot](https://t.me/userinfobot)
2. Отправить ему любое сообщение
3. Скопировать число из поля `Id` — например, `123456789`

### 7. Создать конфиг

```bash
cd /opt/vk-turn-bot
cp .env.example .env
nano .env
```

Заполнить обязательные поля:

```env
# Токен от @BotFather (шаг 5)
BOT_TOKEN=8210090927:AAH...

# Твой chat ID от @userinfobot (шаг 6)
ADMIN_CHAT_ID=123456789
```

Остальные поля можно оставить по умолчанию:

```env
# Путь к бинарнику vk-turn-client (для проверки ссылки)
VK_TURN_CLIENT_PATH=/usr/local/bin/vk-turn-client

# Путь к бинарнику vk-turn-server
VK_TURN_SERVER_PATH=/usr/local/bin/vk-turn-server

# Путь к конфиг-файлу
CONFIG_PATH=/etc/vk-turn-proxy/config.json

# Имя systemd-сервиса vk-turn-proxy
SYSTEMD_SERVICE=vk-turn-proxy

# WireGuard на этом же VPS
WG_PEER_IP=127.0.0.1
WG_PEER_PORT=51820

# Порт vk-turn-proxy сервера
VK_TURN_LISTEN_PORT=56000

# Публичный IP VPS (нужен для проверки ссылки через loopback-тест)
VPS_PUBLIC_IP=89.221.215.157

# Интервал проверки TURN (в минутах)
CHECK_INTERVAL_MIN=5
```

### 8. Создать директории

```bash
mkdir -p /etc/vk-turn-proxy
mkdir -p /etc/systemd/system/vk-turn-proxy.service.d
```

- `/etc/vk-turn-proxy/` — здесь бот хранит `config.json` с текущей ссылкой и статистикой
- `/etc/systemd/system/vk-turn-proxy.service.d/` — здесь бот создаёт override при `/restart`

### 9. Установить systemd-сервис

```bash
cp /opt/vk-turn-bot/vk-turn-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vk-turn-bot
systemctl start vk-turn-bot
```

### 10. Проверить

```bash
systemctl status vk-turn-bot
```

Ожидаемый результат:

```
● vk-turn-bot.service - VK TURN Proxy Telegram Monitor
     Active: active (running)
```

В Telegram должно прийти сообщение: `🟢 VK TURN Monitor запущен`

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Список команд + показать клавиатуру |
| `/status` | Проверить, жив ли TURN (сервис + UDP-сокет + ссылка) |
| `/setlink <url>` | Установить новую ссылку и перезапустить сервис |
| `/restart` | Перезапустить vk-turn-proxy сервис (также включает учёт трафика) |
| `/stats` | Аптайм сервиса/бота, перезапуски, детали последней проверки |
| `/config` | Текущие параметры (ссылка замаскирована) |

Основные команды доступны через кнопки внизу чата. Для обновления ссылки достаточно отправить её в чат (vk.com или vk.ru) — бот автоматически применит и перезапустит сервис.

## Первоначальная настройка через Telegram

После запуска бота отправь ссылку на VK-звонок:

```
https://vk.ru/call/join/ваша_ссылка
```

Бот сам обновит конфиг и перезапустит сервис. Проверь результат: `/status`

## Безопасность

- Бот отвечает **только** на сообщения от `ADMIN_CHAT_ID`
- Все остальные сообщения молча игнорируются
- Ссылка VK-звонка хранится в `/etc/vk-turn-proxy/config.json`
- Токен бота хранится в `/opt/vk-turn-bot/.env`, не в коде

## Фоновый мониторинг

Бот автоматически проверяет здоровье TURN каждые `CHECK_INTERVAL_MIN` минут (по умолчанию 5). Первая проверка — через 30 секунд после старта.

Что проверяется:

1. **Сервис** — запущен ли systemd-сервис vk-turn-proxy
2. **UDP-порт** — слушает ли сервер на порту (ss -unlp)
3. **Ссылка** — если на VPS установлен vk-turn-client и задан `VPS_PUBLIC_IP`, бот запускает loopback-тест: клиент пытается установить TURN-сессию через VK и вернуться на сервер по публичному IP. Если ссылка мертва — клиент падает с ошибкой до таймаута

Если TURN не отвечает — бот присылает алерт с причиной:

```
🚨 TURN не отвечает!
Сервис активен, но ссылка не работает:
get TURN creds error: Call not found
Отправь новую ссылку VK-звонка или выполни /restart
```

Все инциденты записываются и попадают в ежедневный отчёт.

## Ежедневный отчёт

Каждый день в **04:00 UTC** бот отправляет сводку:

```
📋 Ежедневный отчёт VK TURN Proxy

Статус: ✅ OK
Сервис: active, 2.6 МБ
Аптайм сервиса: 1д 3ч
Аптайм бота: 1д 3ч
Активные подключения: 1
Трафик за сутки: 142.3 МБ

Происшествия: нет ✅
```

В отчёт входит:

- **Статус** — результат текущей проверки
- **Активные подключения** — количество клиентов, подключённых в момент отчёта
- **Трафик за сутки** — входящий + исходящий трафик сервиса через systemd IPAccounting. Для включения нужен один `/restart` после обновления бота
- **Происшествия** — список сбоев за последние 24 часа с временем и причиной

## Обновление бота

```bash
cd /opt/vk-turn-bot
git pull
npm install
npm run build
systemctl restart vk-turn-bot
```

## Логи

```bash
# Последние логи
journalctl -u vk-turn-bot --no-pager -n 50

# Следить в реальном времени
journalctl -u vk-turn-bot -f
```

## Связанные сервисы на VPS

Бот работает в связке с другими компонентами:

| Сервис | Команда проверки | Порт |
|--------|------------------|------|
| WireGuard | `systemctl status wg-quick@wg0` | 51820/UDP (localhost) |
| vk-turn-proxy server | `systemctl status vk-turn-proxy` | 56000/UDP |
| XRAY (3X-UI) | `systemctl status x-ui` | 443/TCP |
| Telegram-бот | `systemctl status vk-turn-bot` | — |

## Устранение проблем

### Бот не запускается

```bash
journalctl -u vk-turn-bot --no-pager -n 20
```

Частые причины:
- Не заполнен `BOT_TOKEN` в `.env`
- Неверный токен бота
- Node.js не установлен

### Бот не отвечает в Telegram

- Проверить `ADMIN_CHAT_ID` в `.env` — должен совпадать с твоим ID
- Бот отвечает только тебе, остальных игнорирует

### /status показывает «мёртв»

1. Проверить, запущен ли vk-turn-proxy: `systemctl status vk-turn-proxy`
2. Проверить, слушает ли порт: `ss -unlp | grep ":56000"`
3. Если сервис не запущен: `systemctl start vk-turn-proxy`

### /restart выдаёт ошибку

- Убедиться, что ссылка задана: `/config`
- Проверить права: бот должен работать от root (указано в service-файле)
- Проверить директорию override: `ls /etc/systemd/system/vk-turn-proxy.service.d/`

## Структура проекта

```
/opt/vk-turn-bot/
├── src/
│   └── index.ts          # Исходный код бота
├── dist/
│   └── index.js          # Скомпилированный JS
├── .env                  # Конфигурация (не в git)
├── .env.example          # Шаблон конфигурации
├── package.json
├── tsconfig.json
├── vk-turn-bot.service   # Systemd unit-файл
└── README.md
```
