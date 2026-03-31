# VK TURN Proxy Monitor

Telegram-бот для мониторинга и управления vk-turn-proxy на VPS.

## Возможности

- Проверка здоровья TURN-соединения каждые 5 минут
- Алерт в Telegram, если TURN перестал отвечать
- Обновление ссылки на VK-звонок через бота
- Перезапуск vk-turn-proxy через бота
- Статистика: аптайм, количество перезапусков

## Установка на VPS

### 1. Создать бота в Telegram

Написать @BotFather, отправить `/newbot`, получить токен.

### 2. Узнать свой chat ID

Написать @userinfobot, он покажет ID.

### 3. Установить бота на VPS

```bash
# Клонируем/копируем проект
cp -r vk-turn-bot /opt/vk-turn-bot
cd /opt/vk-turn-bot

# Устанавливаем зависимости и собираем
npm install
npm run build

# Создаём конфиг
cp .env.example .env
nano .env  # Заполняем BOT_TOKEN и ADMIN_CHAT_ID

# Создаём директорию для конфига vk-turn-proxy
mkdir -p /etc/vk-turn-proxy
mkdir -p /etc/systemd/system/vk-turn-proxy.service.d
```

### 4. Настроить systemd

```bash
# Копируем сервис
cp vk-turn-bot.service /etc/systemd/system/

# Запускаем
systemctl daemon-reload
systemctl enable vk-turn-bot
systemctl start vk-turn-bot

# Проверяем
systemctl status vk-turn-bot
journalctl -u vk-turn-bot -f
```

### 5. Первоначальная настройка через Telegram

```
/setlink https://vk.com/call/join/ваша_ссылка
/restart
/status
```

## Команды бота

| Команда | Описание |
|---------|----------|
| `/status` | Проверить, жив ли TURN |
| `/setlink <url>` | Установить новую ссылку VK-звонка |
| `/restart` | Перезапустить vk-turn-proxy |
| `/stats` | Статистика: аптайм, перезапуски |
| `/config` | Текущая конфигурация |

## Безопасность

Бот отвечает **только** на сообщения от ADMIN_CHAT_ID.
Все остальные сообщения молча игнорируются.
Ссылка VK-звонка хранится в `/etc/vk-turn-proxy/config.json`.
