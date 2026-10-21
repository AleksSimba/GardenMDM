# GardenMDM API

Базовый путь `/api`, JSON UTF-8. UUID передаются строками. Временные метки — ISO 8601; календарные даты проектов — `YYYY-MM-DD`. Авторизации в локальной версии нет. Для доступа к удалённому серверу используйте SSH-туннель из README.

## Ответы и ошибки

Одна запись: `{ "data": { ... } }`. Создание — 201. Список:

```json
{"data":[],"pagination":{"page":1,"limit":20,"total":0,"total_pages":0}}
```

Успешное удаление счёта — 204 без тела. Ошибка:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Проверьте заполнение полей","fields":{"inn":"Некорректный ИНН"}}}
```

400 — данные/JSON/UUID/параметры некорректны; 404 — запись или маршрут не найдены; 409 — конфликт уникальности или бизнес-правила; 500 — непредвиденная ошибка; 503 — временная недоступность БД. SQL и внутренние stack trace в ответах отсутствуют.

Неизвестные поля запрещены. PATCH меняет только переданные поля; пустой объект запрещён. `null` разрешён только для nullable-полей. Передавать `inn` в PATCH контрагента запрещено даже с текущим значением.

## Контрагенты

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/contractors` | Список |
| GET | `/contractors/:id` | Карточка, включая `bank_accounts` |
| POST | `/contractors` | Создание вместе со счетами |
| PATCH | `/contractors/:id` | `full_name`, `kpp`, `legal_address` |
| PATCH | `/contractors/:id/status` | Статус, тело `{"status":"ACTIVE"}` |

Список: `page=1`, `limit=20` (максимум 100), `search`, `status`, `sort_by`, `sort_order=asc|desc`. Статус отсутствует — все записи; `ALL` не передавать. Поиск — буквальная подстрока в названии/ИНН, без учёта регистра. `%` и `_` не являются масками.

Сортировка: `full_name`, `inn`, `status`, `created_at`, `updated_at`; по умолчанию `created_at desc`. Второй ключ всегда `id` с тем же направлением.

Пример создания (демонстрационные реквизиты):

```bash
curl -X POST http://127.0.0.1/api/contractors \
  -H 'Content-Type: application/json' \
  -d '{
    "full_name":"ООО Пример",
    "inn":"9900020013",
    "kpp":"990001001",
    "legal_address":"Демонстрационный адрес",
    "bank_accounts":[
      {"bank_name":"Демо Банк","bik":"044000001","account_number":"40702810000000002001","currency":"RUB","is_primary":true},
      {"bank_name":"Демо Банк Резерв","bik":"044000002","account_number":"40702810000000002002","currency":"RUB"}
    ]
  }'
```

Для повторного примера нужен другой корректный уникальный ИНН. После создания статус `PENDING_REVIEW`. Перед назначением участником проекта утвердите запись endpoint статуса.

## Счета

| Метод | Путь | Назначение |
| --- | --- | --- |
| POST | `/contractors/:id/bank-accounts` | Добавление |
| PATCH | `/contractors/:id/bank-accounts/:accountId` | Изменение реквизитов |
| PATCH | `/contractors/:id/bank-accounts/:accountId/primary` | Назначение основным, тело `{}` |
| DELETE | `/contractors/:id/bank-accounts/:accountId` | Удаление |

Поля: `bank_name`, `bik`, `account_number`, `correspondent_account` (nullable), `currency` (RUB по умолчанию). При POST допускается `is_primary=true`: основной счёт сменится атомарно. В обычном PATCH поля `is_primary`, `contractor_id`, `id` запрещены. Изменение счёта другого контрагента возвращает 404.

При удалении основного передайте `?replacement_primary_id=<UUID-другого-счёта-этого-контрагента>`. Удаление последнего возвращает 409. Для назначения основного используйте специальный endpoint, а не редактирование реквизитов.

## Проекты

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/projects` | Список с участниками |
| GET | `/projects/:id` | Карточка |
| POST | `/projects` | Создание |
| PATCH | `/projects/:id` | Частичное изменение |

Поля: `name`, `address`, `city`, `customer_id`, `intermediary_id` (nullable, необязателен), `contractor_id`, `start_date`, `end_date`, `tep` (по умолчанию `[]`).

Ответ включает объекты `customer`, `intermediary`, `contractor` с полями `id`, `full_name`, `status` вместе с соответствующими внешними ключами.

Список: общие `page`, `limit`, `search`, `sort_by`, `sort_order`; фильтры `city` (точное совпадение), `customer_id`, `intermediary_id`, `contractor_id`. Поиск — по названию, адресу, городу. Сортировка: `name`, `city`, `start_date`, `end_date`, `created_at`, `updated_at`. По умолчанию `created_at desc`, затем `id desc`.

Пример с активными демонстрационными участниками:

```bash
curl -X POST http://127.0.0.1/api/projects \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"Новый строительный объект",
    "address":"Демонстрационный адрес: участок 10",
    "city":"Москва",
    "customer_id":"10000000-0000-4000-8000-000000000001",
    "intermediary_id":null,
    "contractor_id":"10000000-0000-4000-8000-000000000003",
    "start_date":"2026-10-21",
    "end_date":"2028-12-31",
    "tep":[{"name":"Общая площадь","value":12500.5,"unit":"м²"}]
  }'
```

Для выбора активных участников: `/contractors?status=ACTIVE&search=...&page=1&limit=10&sort_by=full_name&sort_order=asc`.

## Служебные маршруты

- `GET /health/live` — процесс отвечает.
- `GET /health/ready` — миграции завершены и БД доступна; иначе 503.
- `GET /summary` — числа `contractors`, `pending`, `projects`, `accounts` в `data`.
