# media-proxy

Прототип HLS-прокси для проверки гипотезы с `gap.mp4` в потоках MediaMTX.

Сервис принимает HLS URL, забирает playlist у MediaMTX, переписывает вложенные ссылки через себя и помечает `gap.mp4` как HLS gap.

Proxy URL сохраняет исходное расширение в path, чтобы HLS-клиенты видели `.m3u8` / `.mp4`:

```text
/proxy/video1_stream.m3u8?url=https%3A%2F%2F...
/proxy/segment.mp4?url=https%3A%2F%2F...
```

Пример обработки gap:

```m3u8
#EXTINF:1.00000,
#EXT-X-GAP
gap.mp4
```

Для обычных `.mp4` сегментов сервис работает как passthrough proxy.

## Запуск

```bash
npm start
```

По умолчанию сервис слушает:

```text
http://localhost:8088
```

Проверка:

```bash
curl 'http://localhost:8088/health'
```

## Проверка HLS

```bash
URL='https://video.umkey.ru:8888/abc20932_7733_4a3d_bdce_6f8e0820b736/index.m3u8?sessionId=...'
PROXY_URL="http://localhost:8088/proxy/index.m3u8?url=$(node -p 'encodeURIComponent(process.argv[1])' "$URL")"

curl "$PROXY_URL"
ffprobe -v verbose -i "$PROXY_URL"
```

В ответе `index.m3u8` ссылки на вложенные playlists должны быть переписаны на `/proxy/video1_stream.m3u8?url=...`.

В ответе `video1_stream.m3u8` рядом с `gap.mp4` должен появиться `#EXT-X-GAP`.

## Ограничение хостов

Для локального прототипа прокси по умолчанию принимает любой `http/https` target URL. Для стенда лучше ограничить список:

```bash
MEDIA_PROXY_ALLOWED_HOSTS='video.umkey.ru:8888' npm start
```

## Переменные окружения

```text
PORT=8088
PROXY_PATH=/proxy
MEDIA_PROXY_ALLOWED_HOSTS=video.umkey.ru:8888
MEDIA_PROXY_DUMP_PLAYLISTS=1
MEDIA_PROXY_PLAYLIST_DUMP_DIR=./playlist-dumps
MEDIA_PROXY_LOG_FILE=./log.txt
MEDIA_PROXY_JSON_LOG_FILE=./log.jsonl
```

## Сохранение плейлистов

Чтобы сохранять полный оригинальный и переписанный `.m3u8` на каждый playlist-запрос:

```bash
MEDIA_PROXY_DUMP_PLAYLISTS=1 PORT=8090 npm start
```

Файлы будут сохраняться в `playlist-dumps`:

```text
*.original.m3u8
*.rewritten.m3u8
*.meta.json
```

## Что проверяем

Основная гипотеза: iOS `AVPlayer` падает, когда получает из HLS ссылку на `gap.mp4`, который MediaMTX отдает как `404`.

Этот прокси проверяет самый легкий вариант исправления: оставить HLS timeline, но явно сказать клиенту, что сегмент является gap через `#EXT-X-GAP`.

Если `AVPlayer` продолжит падать, следующий вариант - отдавать вместо `gap.mp4` валидный placeholder-сегмент или перейти к полноценному repackaging потока.
