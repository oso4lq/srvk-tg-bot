# VK TURN Proxy Monitor

Telegram-бот для мониторинга и управления vk-turn-proxy на VPS.

## Что делает

- Принимает ссылку на VK-звонок через Telegram — сохраняет, публикует в VK-группу, проверяет TURN с ретраями
- Публикует ссылку на стену закрытой VK-группы (роутер забирает по крону)
- Проверяет здоровье TURN-соединения каждые 5 минут (сервис + UDP-порт + проверка ссылки клиентом)
- Отправляет алерт в Telegram с описанием причины, если TURN перестал отвечать
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

# Chat ID админов через запятую (шаг 6)
ADMIN_CHAT_ID=123456789
```

Публикация в VK (опционально — для передачи ссылки роутеру через VK-группу):

```env
# Токен сообщества VK с правами на стену
VK_GROUP_TOKEN=vk1.a.xxx...
# ID группы (без минуса)
VK_GROUP_ID=123456789
```

Остальные поля можно оставить по умолчанию:

```env
# Путь к бинарнику vk-turn-client (для проверки ссылки)
VK_TURN_CLIENT_PATH=/usr/local/bin/vk-turn-client

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

### 8. Создать директорию для конфига

```bash
mkdir -p /etc/vk-turn-proxy
```

Здесь бот хранит `config.json` с текущей ссылкой и статистикой.

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
| `/setlink <url>` | Применить ссылку: сохранить → опубликовать в VK → проверить TURN |
| `/restart` | Перезапустить vk-turn-proxy сервис |
| `/stats` | Аптайм сервиса/бота, перезапуски, детали последней проверки |
| `/config` | Текущие параметры (ссылка замаскирована) |
| `/monitor` | Включить/выключить фоновый мониторинг |

Основные команды доступны через кнопки внизу чата. Для обновления ссылки достаточно отправить её в чат (vk.com или vk.ru) — бот автоматически применит.

## Применение ссылки

Отправь ссылку на VK-звонок в чат:

```
https://vk.com/call/join/ваша_ссылка
```

Бот выполнит цепочку действий и покажет прогресс в одном сообщении:

1. **Сохранение** — записывает ссылку в `/etc/vk-turn-proxy/config.json`
2. **VK** — публикует пост в VK-группе через `wall.post` (если настроен)
3. **Health check** — до 5 попыток проверки TURN с интервалом 10 сек
4. **Отчёт** — финальный статус

Примеры финальных сообщений:

```
✅ Ссылка применена, TURN жив
VK обновлён
```

```
⚠️ Ссылка сохранена, но TURN не отвечает (5/5 попыток)
VK обновлён
```

```
✅ Ссылка применена, TURN жив
Публикация в VK не настроена
```

Дедупликация: если отправить ту же ссылку повторно — бот ответит «Эта ссылка уже активна».

## Публикация в VK (для роутера)

Бот публикует ссылку новым постом на стене закрытой VK-группы. Роутер забирает последний пост по крону через `wall.get` и перезапускает vk-turn-client.

```
Telegram → бот → wall.post → VK-группа → роутер (крон) → wall.get → перезапуск клиента
```

Публикация в VK опциональна. Если переменные `VK_GROUP_TOKEN` и `VK_GROUP_ID` не заданы — ссылка сохраняется только локально.

### Настройка публикации в VK

1. Создать закрытую группу в VK
2. Получить токен сообщества: Управление → Работа с API → Создать ключ (права: стена)
3. Заполнить в `.env`:

```env
VK_GROUP_TOKEN=vk1.a.xxx...
VK_GROUP_ID=123456789
```

4. Перезапустить бота: `systemctl restart vk-turn-bot`

## Роутер: установка fetch-link.sh

Скрипт `router/fetch-link.sh` запускается на роутере по крону, забирает ссылку из VK-группы и перезапускает vk-turn-client.

### 1. Скопировать файлы на роутер

```bash
scp router/fetch-link.sh router/config.sh.example root@192.168.8.1:/tmp/
```

### 2. Установить на роутере

```bash
ssh root@192.168.8.1

mkdir -p /etc/vk-tunnel
cp /tmp/fetch-link.sh /etc/vk-tunnel/
cp /tmp/config.sh.example /etc/vk-tunnel/config.sh
chmod +x /etc/vk-tunnel/fetch-link.sh

vi /etc/vk-tunnel/config.sh
# → Вставить VK_TOKEN и VK_GROUP_ID
```

### 3. Добавить в cron

```bash
crontab -e
```

```
*/5 * * * * /etc/vk-tunnel/fetch-link.sh
```

### 4. Проверить

```bash
# Ручной запуск
sh /etc/vk-tunnel/fetch-link.sh

# Лог
cat /tmp/vk-tunnel.log

# Текущая ссылка
cat /etc/vk-tunnel/current-link.txt
```

## Безопасность

- Бот отвечает **только** на сообщения от перечисленных в `ADMIN_CHAT_ID` пользователей
- Все остальные сообщения молча игнорируются
- Несколько админов указываются через запятую: `ADMIN_CHAT_ID=111,222,333`
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
Отправь новую ссылку VK-звонка
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

- Проверить `ADMIN_CHAT_ID` в `.env` — твой ID должен быть в списке
- Бот отвечает только перечисленным админам, остальных игнорирует

### /status показывает «мёртв»

1. Проверить, запущен ли vk-turn-proxy: `systemctl status vk-turn-proxy`
2. Проверить, слушает ли порт: `ss -unlp | grep ":56000"`
3. Если сервис не запущен: `systemctl start vk-turn-proxy`

### /restart выдаёт ошибку

- Проверить права: бот должен работать от root (указано в service-файле)
- Проверить, что сервис существует: `systemctl cat vk-turn-proxy`

## Структура проекта

```
/opt/vk-turn-bot/
├── src/
│   └── index.ts            # Исходный код бота (VPS)
├── dist/
│   └── index.js            # Скомпилированный JS
├── router/
│   ├── fetch-link.sh       # Скрипт опроса VK API (роутер)
│   └── config.sh.example   # Шаблон конфигурации для роутера
├── .env                    # Конфигурация бота (не в git)
├── .env.example            # Шаблон конфигурации
├── package.json
├── tsconfig.json
├── vk-turn-bot.service     # Systemd unit-файл
└── README.md
```
