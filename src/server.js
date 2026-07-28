import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { rewritePlaylist } from './hlsRewriter.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDir, '..')
const port = Number(process.env.PORT ?? 8088)
const proxyPath = process.env.PROXY_PATH ?? '/proxy'
const allowedHosts = parseAllowedHosts(process.env.MEDIA_PROXY_ALLOWED_HOSTS)
const logFilePath = process.env.MEDIA_PROXY_LOG_FILE ?? path.join(projectRoot, 'log.txt')
const jsonLogFilePath = process.env.MEDIA_PROXY_JSON_LOG_FILE ?? path.join(projectRoot, 'log.jsonl')
const dumpPlaylists = process.env.MEDIA_PROXY_DUMP_PLAYLISTS === '1'
const playlistDumpDir = process.env.MEDIA_PROXY_PLAYLIST_DUMP_DIR ??
  path.join(projectRoot, 'playlist-dumps')
const logFile = fs.createWriteStream(logFilePath, { flags: 'a' })
const jsonLogFile = fs.createWriteStream(jsonLogFilePath, { flags: 'a' })

process.on('uncaughtException', (error) => {
  log('error', 'uncaught exception', { error: errorToLog(error) })
})

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled rejection', { error: errorToLog(reason) })
})

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now()

  try {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    logRequest(req, requestUrl)

    if (requestUrl.pathname === '/health') {
      sendText(res, 200, 'ok\n', 'text/plain; charset=utf-8')
      logDone(req, requestUrl, 200, startedAt)
      return
    }

    if (requestUrl.pathname !== proxyPath && !requestUrl.pathname.startsWith(`${proxyPath}/`)) {
      sendText(res, 404, 'Not found\n', 'text/plain; charset=utf-8')
      logDone(req, requestUrl, 404, startedAt)
      return
    }

    const target = requestUrl.searchParams.get('url')

    if (!target) {
      sendText(res, 400, 'Missing url query parameter\n', 'text/plain; charset=utf-8')
      logDone(req, requestUrl, 400, startedAt)
      return
    }

    await proxy(target, req, res, startedAt, requestUrl)
  } catch (error) {
    log('error', 'request failed', { error: errorToLog(error) })
    if (!res.headersSent) {
      sendText(res, 500, 'Proxy error\n', 'text/plain; charset=utf-8')
    } else {
      res.destroy(error)
    }
  }
})

server.listen(port, () => {
  log('info', `listening on http://localhost:${port}`, { port })
  log('info', `endpoint: http://localhost:${port}${proxyPath}/index.m3u8?url=<encoded-hls-url>`, {
    endpoint: `http://localhost:${port}${proxyPath}/index.m3u8?url=<encoded-hls-url>`
  })
  log('info', `text log: ${logFilePath}`, { logFilePath })
  log('info', `json log: ${jsonLogFilePath}`, { jsonLogFilePath })
  if (dumpPlaylists) {
    log('info', `playlist dumps: ${playlistDumpDir}`, { playlistDumpDir })
  }
})

async function proxy(target, req, res, startedAt, requestUrl) {
  const targetUrl = new URL(target)
  assertAllowedTarget(targetUrl)

  log('info', `-> ${targetUrl.toString()}`, {
    upstreamUrl: targetUrl.toString()
  })

  const upstream = await fetch(targetUrl, {
    headers: buildUpstreamHeaders(req),
    redirect: 'follow'
  })

  const upstreamContentType = upstream.headers.get('content-type') ?? '-'
  log('info', `<- ${upstream.status} ${resourceKind(targetUrl, upstream)} ${upstreamContentType}`, {
    upstreamUrl: targetUrl.toString(),
    upstreamStatus: upstream.status,
    resourceKind: resourceKind(targetUrl, upstream),
    contentType: upstreamContentType
  })

  if (isPlaylist(targetUrl, upstream)) {
    const text = await upstream.text()
    const body = rewritePlaylist(text, targetUrl.toString(), {
      proxyPath,
      onGap: (line) => {
        log('warn', `gap detected source=${targetUrl.toString()} line=${line}`, {
          upstreamUrl: targetUrl.toString(),
          line
        })
      }
    })
    dumpPlaylistIfNeeded(targetUrl, requestUrl, text, body)

    res.writeHead(upstream.status, {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    })
    res.end(body)
    logDone(req, requestUrl, upstream.status, startedAt)
    return
  }

  res.writeHead(upstream.status, responseHeaders(upstream))

  if (!upstream.body) {
    res.end()
    logDone(req, requestUrl, upstream.status, startedAt)
    return
  }

  res.on('finish', () => {
    logDone(req, requestUrl, res.statusCode, startedAt)
  })

  const bodyStream = Readable.fromWeb(upstream.body)

  bodyStream.on('error', (error) => {
    log('warn', 'upstream body stream error', {
      upstreamUrl: targetUrl.toString(),
      error: errorToLog(error)
    })

    if (!res.destroyed) {
      res.destroy(error)
    }
  })

  res.on('error', (error) => {
    log('warn', 'response stream error', {
      upstreamUrl: targetUrl.toString(),
      error: errorToLog(error)
    })
  })

  bodyStream.pipe(res)
}

function isPlaylist(targetUrl, upstream) {
  const contentType = upstream.headers.get('content-type') ?? ''
  return targetUrl.pathname.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('application/vnd.apple.mpegurl')
}

function buildUpstreamHeaders(req) {
  const headers = {}

  for (const name of ['range', 'user-agent', 'accept', 'accept-language']) {
    const value = req.headers[name]
    if (value) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
  }

  return headers
}

function responseHeaders(upstream) {
  const headers = {
    'access-control-allow-origin': '*',
    'cache-control': upstream.headers.get('cache-control') ?? 'no-store'
  }

  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag'
  ]) {
    const value = upstream.headers.get(name)
    if (value) {
      headers[name] = value
    }
  }

  return headers
}

function assertAllowedTarget(targetUrl) {
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error(`Unsupported target protocol: ${targetUrl.protocol}`)
  }

  if (allowedHosts.size > 0 && !allowedHosts.has(targetUrl.host)) {
    throw new Error(`Target host is not allowed: ${targetUrl.host}`)
  }
}

function parseAllowedHosts(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)
  )
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  })
  res.end(body)
}

function logRequest(req, requestUrl) {
  log('info', `${req.method ?? 'GET'} ${requestUrl.pathname}${requestUrl.search}`, {
    method: req.method ?? 'GET',
    path: requestUrl.pathname,
    query: requestUrl.search
  })
}

function logDone(req, requestUrl, status, startedAt) {
  const durationMs = Date.now() - startedAt
  log(
    'info',
    `done ${status} ${durationMs}ms ${req.method ?? 'GET'} ${requestUrl.pathname}`,
    {
      method: req.method ?? 'GET',
      path: requestUrl.pathname,
      status,
      durationMs
    }
  )
}

function resourceKind(targetUrl, upstream) {
  if (isPlaylist(targetUrl, upstream)) {
    return 'playlist'
  }

  if (targetUrl.pathname.endsWith('.mp4')) {
    return 'segment'
  }

  return 'resource'
}

function dumpPlaylistIfNeeded(targetUrl, requestUrl, originalText, rewrittenText) {
  if (!dumpPlaylists) {
    return
  }

  fs.mkdirSync(playlistDumpDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const playlistName = targetUrl.pathname
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? 'playlist.m3u8'
  const baseName = `${timestamp}-${playlistName}`
  const originalPath = path.join(playlistDumpDir, `${baseName}.original.m3u8`)
  const rewrittenPath = path.join(playlistDumpDir, `${baseName}.rewritten.m3u8`)
  const metadataPath = path.join(playlistDumpDir, `${baseName}.meta.json`)
  const gapCount = countMatches(originalText, /(^|\n)gap\.mp4(\?|$|\n)/g)

  fs.writeFileSync(originalPath, originalText)
  fs.writeFileSync(rewrittenPath, rewrittenText)
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        dumpedAt: new Date().toISOString(),
        targetUrl: targetUrl.toString(),
        requestPath: requestUrl.pathname,
        requestQuery: requestUrl.search,
        gapCount,
        originalPath,
        rewrittenPath
      },
      null,
      2
    ) + '\n'
  )

  log('info', `playlist dumped ${playlistName} gapCount=${gapCount}`, {
    targetUrl: targetUrl.toString(),
    gapCount,
    originalPath,
    rewrittenPath,
    metadataPath
  })
}

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length
}

function log(level, message, fields = {}) {
  const timestamp = new Date().toISOString()
  const textLine = `[media-proxy] ${message}`
  const fileLine = `${timestamp} ${level.toUpperCase()} ${textLine}\n`
  const jsonLine = JSON.stringify({
    timestamp,
    level,
    message,
    ...fields
  }) + '\n'

  if (level === 'error') {
    console.error(textLine)
  } else if (level === 'warn') {
    console.warn(textLine)
  } else {
    console.log(textLine)
  }

  logFile.write(fileLine)
  jsonLogFile.write(jsonLine)
}

function errorToLog(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }

  return String(error)
}
