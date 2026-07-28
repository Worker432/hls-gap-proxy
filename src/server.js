import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  isMediaSegmentUrl,
  liveEdgeSegmentUrls,
  mediaSegmentKey,
  playlistSummary,
  rewritePlaylist
} from './hlsRewriter.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDir, '..')
const port = Number(process.env.PORT ?? 8088)
const proxyPath = process.env.PROXY_PATH ?? '/proxy'
const allowedHosts = parseAllowedHosts(process.env.MEDIA_PROXY_ALLOWED_HOSTS)
const liveEdgeSegmentCount = parsePositiveInteger(process.env.MEDIA_PROXY_LIVE_EDGE_SEGMENTS, 3)
const missingSegmentTtlMs = parsePositiveInteger(process.env.MEDIA_PROXY_MISSING_SEGMENT_TTL_MS, 120_000)
const preflightSegments = process.env.MEDIA_PROXY_PREFLIGHT_SEGMENTS !== '0'
const preflightTimeoutMs = parsePositiveInteger(process.env.MEDIA_PROXY_PREFLIGHT_TIMEOUT_MS, 2_000)
const restreamEnabled = process.env.MEDIA_PROXY_RESTREAM_ENABLED !== '0'
const restreamSourceSegmentCount = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_SOURCE_SEGMENTS, 5)
const restreamWindowSegmentCount = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_WINDOW_SEGMENTS, 3)
const restreamMinReadySegments = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_MIN_READY_SEGMENTS, 2)
const restreamInitialWaitMs = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_INITIAL_WAIT_MS, 5_000)
const restreamReloadWaitMs = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_RELOAD_WAIT_MS, 1_500)
const restreamMaxCachedSegments = parsePositiveInteger(process.env.MEDIA_PROXY_RESTREAM_MAX_CACHED_SEGMENTS, 30)
const logFilePath = process.env.MEDIA_PROXY_LOG_FILE ?? path.join(projectRoot, 'log.txt')
const jsonLogFilePath = process.env.MEDIA_PROXY_JSON_LOG_FILE ?? path.join(projectRoot, 'log.jsonl')
const dumpPlaylists = process.env.MEDIA_PROXY_DUMP_PLAYLISTS === '1'
const playlistDumpDir = process.env.MEDIA_PROXY_PLAYLIST_DUMP_DIR ??
  path.join(projectRoot, 'playlist-dumps')
const logFile = fs.createWriteStream(logFilePath, { flags: 'a' })
const jsonLogFile = fs.createWriteStream(jsonLogFilePath, { flags: 'a' })
const cookieJar = new Map()
const playlistStates = new Map()
const missingSegments = new Map()
const restreamsByPlaylistKey = new Map()
const restreamsById = new Map()

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

    if (requestUrl.pathname.startsWith(`${proxyPath}/restream/`)) {
      await serveRestreamSegment(req, res, startedAt, requestUrl)
      return
    }

    if (requestUrl.pathname !== proxyPath && !requestUrl.pathname.startsWith(`${proxyPath}/`)) {
      sendText(res, 404, 'Not found\n', 'text/plain; charset=utf-8')
      logDone(req, requestUrl, 404, startedAt)
      return
    }

    const targetUrl = buildTargetUrl(requestUrl)

    if (!targetUrl) {
      sendText(res, 400, 'Missing url query parameter\n', 'text/plain; charset=utf-8')
      logDone(req, requestUrl, 400, startedAt)
      return
    }

    await proxy(targetUrl, req, res, startedAt, requestUrl)
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
  log('info', 'normalizer config', {
    liveEdgeSegmentCount,
    missingSegmentTtlMs,
    preflightSegments,
    preflightTimeoutMs,
    restreamEnabled,
    restreamSourceSegmentCount,
    restreamWindowSegmentCount,
    restreamMinReadySegments,
    restreamInitialWaitMs,
    restreamReloadWaitMs,
    restreamMaxCachedSegments
  })
  if (dumpPlaylists) {
    log('info', `playlist dumps: ${playlistDumpDir}`, { playlistDumpDir })
  }
})

async function proxy(targetUrl, req, res, startedAt, requestUrl) {
  assertAllowedTarget(targetUrl)
  cleanupMissingSegments()

  let effectiveTargetUrl = targetUrl
  let upstream = await fetchUpstream(targetUrl, req)

  if (!upstream.ok && upstream.status === 401 && isPlaylistUrl(targetUrl)) {
    const recovered = await recoverUnauthorizedPlaylist(targetUrl, req)
    if (recovered) {
      await upstream.body?.cancel().catch(() => {})
      effectiveTargetUrl = recovered.targetUrl
      upstream = recovered.upstream
    }
  }

  if (!upstream.ok) {
    await passThroughUpstreamError(upstream, req, res, startedAt, requestUrl, effectiveTargetUrl)
    return
  }

  if (isMediaSegmentUrl(effectiveTargetUrl.toString())) {
    clearMissingSegment(effectiveTargetUrl)
  }

  if (isPlaylist(effectiveTargetUrl, upstream)) {
    const text = await upstream.text()
    logPlaylistSummary('playlist summary', effectiveTargetUrl, text)

    if (restreamEnabled && playlistSummary(text).kind === 'media') {
      const body = await restreamPlaylist(text, effectiveTargetUrl, req, requestUrl)
      logPlaylistSummary('restream playlist summary', effectiveTargetUrl, body)
      dumpPlaylistIfNeeded(effectiveTargetUrl, requestUrl, text, body)

      res.writeHead(upstream.status, {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      })
      res.end(body)
      logDone(req, requestUrl, upstream.status, startedAt)
      return
    }

    const preflight = await preflightLiveEdgeSegments(text, effectiveTargetUrl, req)
    const suppressMissingGaps = shouldSuppressMissingGaps(preflight)

    const body = rewritePlaylist(text, effectiveTargetUrl.toString(), {
      proxyPath,
      proxyBaseUrl: `${requestUrl.protocol}//${requestUrl.host}`,
      liveEdgeSegmentCount,
      isGapUrl: (url) => !suppressMissingGaps && isMissingSegment(url),
      onGap: (line) => {
        log('warn', `gap emitted source=${effectiveTargetUrl.toString()} line=${line}`, {
          upstreamUrl: effectiveTargetUrl.toString(),
          line
        })
      }
    })
    logPlaylistSummary('rewritten playlist summary', effectiveTargetUrl, body)
    dumpPlaylistIfNeeded(effectiveTargetUrl, requestUrl, text, body)

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

async function fetchUpstream(targetUrl, req) {
  log('info', `-> ${targetUrl.toString()}`, {
    upstreamUrl: targetUrl.toString()
  })

  const upstream = await fetch(targetUrl, {
    headers: buildUpstreamHeaders(req, targetUrl),
    redirect: 'follow'
  })

  storeUpstreamCookies(targetUrl, upstream.headers)

  const upstreamContentType = upstream.headers.get('content-type') ?? '-'
  log('info', `<- ${upstream.status} ${resourceKind(targetUrl, upstream)} ${upstreamContentType}`, {
    upstreamUrl: targetUrl.toString(),
    upstreamStatus: upstream.status,
    resourceKind: resourceKind(targetUrl, upstream),
    contentType: upstreamContentType
  })

  return upstream
}

async function recoverUnauthorizedPlaylist(targetUrl, req) {
  const masterUrl = masterUrlForPlaylist(targetUrl)
  if (!masterUrl) {
    return null
  }

  log('warn', `playlist auth failed, refreshing master ${masterUrl.toString()}`, {
    upstreamUrl: targetUrl.toString(),
    masterUrl: masterUrl.toString()
  })

  const masterResponse = await fetchUpstream(masterUrl, req)
  if (!masterResponse.ok || !isPlaylist(masterUrl, masterResponse)) {
    await masterResponse.body?.cancel().catch(() => {})
    log('warn', `playlist auth refresh failed status=${masterResponse.status}`, {
      upstreamUrl: targetUrl.toString(),
      masterUrl: masterUrl.toString(),
      upstreamStatus: masterResponse.status
    })
    return null
  }

  const masterText = await masterResponse.text()
  logPlaylistSummary('auth refresh master summary', masterUrl, masterText)

  const variantLine = firstPlaylistUri(masterText)
  if (!variantLine) {
    log('warn', 'playlist auth refresh failed: master has no variant URI', {
      upstreamUrl: targetUrl.toString(),
      masterUrl: masterUrl.toString()
    })
    return null
  }

  const refreshedUrl = new URL(variantLine, masterUrl)
  refreshedUrl.searchParams.delete('iosHlsRecoveryAttempt')

  log('info', `playlist auth refreshed ${targetUrl.toString()} -> ${refreshedUrl.toString()}`, {
    previousUpstreamUrl: targetUrl.toString(),
    refreshedUpstreamUrl: refreshedUrl.toString()
  })

  const refreshedResponse = await fetchUpstream(refreshedUrl, req)
  if (!refreshedResponse.ok) {
    log('warn', `playlist auth refreshed URL failed status=${refreshedResponse.status}`, {
      upstreamUrl: refreshedUrl.toString(),
      upstreamStatus: refreshedResponse.status
    })
    return { targetUrl: refreshedUrl, upstream: refreshedResponse }
  }

  return { targetUrl: refreshedUrl, upstream: refreshedResponse }
}

async function passThroughUpstreamError(upstream, req, res, startedAt, requestUrl, targetUrl) {
  const body = await upstream.text()
  const trimmedBody = body.trim()

  if (upstream.status === 404 && isMediaSegmentUrl(targetUrl.toString())) {
    markMissingSegment(targetUrl, 'upstream 404')
  }

  log('warn', `upstream error ${upstream.status}: ${truncate(trimmedBody || '<empty body>', 1000)}`, {
    upstreamUrl: targetUrl.toString(),
    upstreamStatus: upstream.status,
    body: truncate(trimmedBody, 4000)
  })

  res.writeHead(upstream.status, responseHeaders(upstream))
  res.end(body)
  logDone(req, requestUrl, upstream.status, startedAt)
}

async function serveRestreamSegment(req, res, startedAt, requestUrl) {
  const match = requestUrl.pathname.match(new RegExp(`^${escapeRegExp(proxyPath)}/restream/([^/]+)/([^/]+)$`))
  if (!match) {
    sendText(res, 404, 'Not found\n', 'text/plain; charset=utf-8')
    logDone(req, requestUrl, 404, startedAt)
    return
  }

  const [, streamId, rawSequence] = match
  const sequence = Number(rawSequence.replace(/\.[^.]+$/, ''))
  const state = restreamsById.get(streamId)
  const segment = state?.segments.get(sequence)

  if (!state || !segment) {
    sendText(res, 404, 'Restream segment not found\n', 'text/plain; charset=utf-8')
    logDone(req, requestUrl, 404, startedAt)
    return
  }

  if (!segment.ready && segment.fetchPromise) {
    await Promise.race([
      segment.fetchPromise.catch(() => null),
      delay(restreamInitialWaitMs)
    ])
  }

  if (!segment.ready || !segment.body) {
    sendText(res, 404, 'Restream segment is not ready\n', 'text/plain; charset=utf-8')
    logDone(req, requestUrl, 404, startedAt)
    return
  }

  res.writeHead(200, {
    'content-type': segment.contentType || 'video/mp2t',
    'content-length': segment.body.length,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(segment.body)
  log('info', `restream segment served id=${state.id} seq=${segment.sequence} bytes=${segment.body.length}`, {
    restreamId: state.id,
    sequence: segment.sequence,
    byteLength: segment.body.length,
    sourceUrl: segment.url
  })
  logDone(req, requestUrl, 200, startedAt)
}

async function restreamPlaylist(text, targetUrl, req, requestUrl) {
  const state = restreamStateFor(targetUrl)
  const parsed = parseMediaPlaylist(text, targetUrl.toString())
  state.targetDuration = parsed.targetDuration || state.targetDuration || 2
  state.lastUpstreamUrl = targetUrl.toString()
  state.lastUpdatedAt = Date.now()

  const candidates = parsed.segments.slice(-restreamSourceSegmentCount)
  for (const parsedSegment of candidates) {
    const segment = ensureRestreamSegment(state, parsedSegment)
    if (!segment.ready && !segment.fetchPromise) {
      segment.fetchPromise = fetchRestreamSegment(state, segment, req)
    }
  }

  pruneRestreamState(state)

  const waitMs = state.hasServedPlaylist ? restreamReloadWaitMs : restreamInitialWaitMs
  await waitForRestreamSegments(state, restreamMinReadySegments, waitMs)

  const playlist = buildRestreamPlaylist(state, requestUrl)
  state.hasServedPlaylist = true

  if (playlist) {
    state.lastPlaylistBody = playlist
    return playlist
  }

  if (state.lastPlaylistBody) {
    log('warn', `restream using previous playlist id=${state.id}: no contiguous ready live window`, {
      restreamId: state.id
    })
    return state.lastPlaylistBody
  }

  log('warn', `restream empty playlist id=${state.id}: no ready segments yet`, {
    restreamId: state.id,
    upstreamUrl: targetUrl.toString()
  })
  return emptyRestreamPlaylist(state)
}

function restreamStateFor(targetUrl) {
  const key = restreamPlaylistKey(targetUrl)
  const existing = restreamsByPlaylistKey.get(key)
  if (existing) {
    return existing
  }

  const id = crypto
    .createHash('sha1')
    .update(`${key}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 12)

  const state = {
    id,
    key,
    targetDuration: 2,
    lastUpstreamUrl: targetUrl.toString(),
    lastUpdatedAt: Date.now(),
    hasServedPlaylist: false,
    lastPlaylistBody: '',
    segments: new Map()
  }

  restreamsByPlaylistKey.set(key, state)
  restreamsById.set(id, state)
  log('info', `restream state created id=${id} key=${key}`, {
    restreamId: id,
    restreamKey: key,
    upstreamUrl: targetUrl.toString()
  })
  return state
}

function ensureRestreamSegment(state, parsedSegment) {
  const existing = state.segments.get(parsedSegment.sequence)
  if (existing) {
    existing.url = parsedSegment.url
    existing.duration = parsedSegment.duration || existing.duration
    return existing
  }

  const segment = {
    sequence: parsedSegment.sequence,
    duration: parsedSegment.duration || state.targetDuration || 2,
    url: parsedSegment.url,
    ready: false,
    failed: false,
    status: null,
    contentType: 'video/mp2t',
    body: null,
    fetchPromise: null,
    updatedAt: Date.now()
  }

  state.segments.set(segment.sequence, segment)
  return segment
}

async function fetchRestreamSegment(state, segment, req) {
  const targetUrl = new URL(segment.url)
  try {
    log('info', `restream fetch segment id=${state.id} seq=${segment.sequence}`, {
      restreamId: state.id,
      sequence: segment.sequence,
      upstreamUrl: targetUrl.toString()
    })

    const response = await fetch(targetUrl, {
      headers: buildUpstreamHeaders(req, targetUrl),
      redirect: 'follow'
    })

    storeUpstreamCookies(targetUrl, response.headers)
    segment.status = response.status

    if (!response.ok) {
      segment.failed = true
      const body = await response.text().catch(() => '')
      log('warn', `restream segment fetch failed id=${state.id} seq=${segment.sequence} status=${response.status}`, {
        restreamId: state.id,
        sequence: segment.sequence,
        upstreamUrl: targetUrl.toString(),
        upstreamStatus: response.status,
        body: truncate(body.trim(), 1000)
      })
      return
    }

    const body = Buffer.from(await response.arrayBuffer())
    segment.body = body
    segment.contentType = response.headers.get('content-type') || 'video/mp2t'
    segment.ready = true
    segment.failed = false
    segment.updatedAt = Date.now()
    clearMissingSegment(targetUrl)

    log('info', `restream segment ready id=${state.id} seq=${segment.sequence} bytes=${body.length}`, {
      restreamId: state.id,
      sequence: segment.sequence,
      upstreamUrl: targetUrl.toString(),
      byteLength: body.length,
      contentType: segment.contentType
    })
  } catch (error) {
    segment.failed = true
    log('warn', `restream segment fetch error id=${state.id} seq=${segment.sequence}`, {
      restreamId: state.id,
      sequence: segment.sequence,
      upstreamUrl: targetUrl.toString(),
      error: errorToLog(error)
    })
  } finally {
    segment.fetchPromise = null
  }
}

async function waitForRestreamSegments(state, minReadySegments, timeoutMs) {
  const readyCount = () => contiguousReadyLiveWindow(state).length
  if (readyCount() >= minReadySegments) {
    return
  }

  const pending = Array.from(state.segments.values())
    .map((segment) => segment.fetchPromise)
    .filter(Boolean)

  if (pending.length === 0) {
    return
  }

  await Promise.race([
    Promise.allSettled(pending),
    delay(timeoutMs)
  ])
}

function buildRestreamPlaylist(state, requestUrl) {
  const window = contiguousReadyLiveWindow(state).slice(-restreamWindowSegmentCount)
  if (window.length === 0) {
    return ''
  }

  const targetDuration = Math.max(
    Math.ceil(state.targetDuration || 2),
    Math.ceil(Math.max(...window.map((segment) => segment.duration || 0), 1))
  )
  const baseUrl = `${requestUrl.protocol}//${requestUrl.host}${proxyPath}/restream/${state.id}`
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${window[0].sequence}`,
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ]

  for (const segment of window) {
    lines.push(`#EXTINF:${formatDuration(segment.duration || targetDuration)},`)
    lines.push(`${baseUrl}/${segment.sequence}.ts`)
  }

  log('info', `restream playlist built id=${state.id} seq=${window[0].sequence} uris=${window.length} last=${window.at(-1).sequence}`, {
    restreamId: state.id,
    mediaSequence: window[0].sequence,
    uriCount: window.length,
    lastSequence: window.at(-1).sequence
  })

  return `${lines.join('\n')}\n`
}

function contiguousReadyLiveWindow(state) {
  const ready = Array.from(state.segments.values())
    .filter((segment) => segment.ready && segment.body)
    .sort((left, right) => left.sequence - right.sequence)

  if (ready.length === 0) {
    return []
  }

  const bySequence = new Map(ready.map((segment) => [segment.sequence, segment]))
  const lastSequence = ready.at(-1).sequence
  const window = []

  for (let sequence = lastSequence; bySequence.has(sequence); sequence -= 1) {
    window.unshift(bySequence.get(sequence))
  }

  return window
}

function emptyRestreamPlaylist(state) {
  const targetDuration = Math.max(Math.ceil(state.targetDuration || 2), 1)
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    ''
  ].join('\n')
}

function pruneRestreamState(state) {
  const sequences = Array.from(state.segments.keys()).sort((left, right) => left - right)
  const removeCount = Math.max(0, sequences.length - restreamMaxCachedSegments)

  for (const sequence of sequences.slice(0, removeCount)) {
    state.segments.delete(sequence)
  }
}

function parseMediaPlaylist(text, sourceUrl) {
  const lines = text.split(/\r?\n/)
  const segments = []
  let mediaSequence = 0
  let targetDuration = 0
  let currentDuration = 0
  let segmentIndex = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }

    if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsed = Number(trimmed.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
      if (Number.isFinite(parsed)) {
        mediaSequence = parsed
      }
      continue
    }

    if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
      const parsed = Number(trimmed.slice('#EXT-X-TARGETDURATION:'.length))
      if (Number.isFinite(parsed)) {
        targetDuration = parsed
      }
      continue
    }

    if (trimmed.startsWith('#EXTINF:')) {
      const durationText = trimmed
        .slice('#EXTINF:'.length)
        .split(',', 1)[0]
      const parsed = Number(durationText)
      currentDuration = Number.isFinite(parsed) ? parsed : 0
      continue
    }

    if (trimmed.startsWith('#')) {
      continue
    }

    segments.push({
      sequence: mediaSequence + segmentIndex,
      duration: currentDuration || targetDuration || 2,
      url: new URL(trimmed, sourceUrl).toString()
    })
    currentDuration = 0
    segmentIndex += 1
  }

  return {
    mediaSequence,
    targetDuration,
    segments
  }
}

function restreamPlaylistKey(targetUrl) {
  const keyUrl = new URL(targetUrl.toString())
  keyUrl.searchParams.delete('session')
  keyUrl.searchParams.delete('iosHlsRecoveryAttempt')
  return keyUrl.toString()
}

function formatDuration(duration) {
  const numericDuration = Number(duration)
  if (!Number.isFinite(numericDuration) || numericDuration <= 0) {
    return '1.000'
  }

  return numericDuration.toFixed(3)
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function preflightLiveEdgeSegments(text, playlistUrl, req) {
  if (!preflightSegments) {
    return { urls: [], results: [] }
  }

  const urls = liveEdgeSegmentUrls(text, playlistUrl.toString(), liveEdgeSegmentCount)
  if (urls.length === 0) {
    return { urls, results: [] }
  }

  const results = await Promise.all(urls.map((url) => preflightSegment(url, req)))
  return { urls, results }
}

function shouldSuppressMissingGaps(preflight) {
  if (preflight.urls.length === 0) {
    return false
  }

  const checkedResults = preflight.results.filter((result) => result.checked)
  if (checkedResults.length === 0) {
    return false
  }

  const allCheckedSegmentsAreMissing = checkedResults.every((result) => result.missing)
  if (!allCheckedSegmentsAreMissing) {
    return false
  }

  log('warn', 'suppressing missing segment gaps because every checked live-edge segment is missing', {
    checkedSegmentCount: checkedResults.length,
    missingSegmentCount: checkedResults.filter((result) => result.missing).length
  })

  return true
}

async function preflightSegment(url, req) {
  const targetUrl = new URL(url)
  if (isMissingSegment(url)) {
    return { checked: true, missing: true, cached: true }
  }

  try {
    const response = await fetchWithTimeout(targetUrl, {
      method: 'HEAD',
      headers: buildUpstreamHeaders(req, targetUrl),
      redirect: 'follow'
    })

    storeUpstreamCookies(targetUrl, response.headers)

    if (response.status === 404 || response.status === 410) {
      log('warn', `segment HEAD preflight returned ${response.status}, confirming with range GET`, {
        upstreamUrl: targetUrl.toString(),
        upstreamStatus: response.status
      })
      return await preflightSegmentWithRangeGet(targetUrl, req, `preflight HEAD ${response.status}`)
    }

    if (response.ok) {
      clearMissingSegment(targetUrl)
      return { checked: true, missing: false }
    }

    if (response.status === 405 || response.status === 501) {
      return await preflightSegmentWithRangeGet(targetUrl, req, `preflight HEAD ${response.status}`)
    }

    log('warn', `segment preflight returned ${response.status}`, {
      upstreamUrl: targetUrl.toString(),
      upstreamStatus: response.status
    })
    return { checked: false, missing: false }
  } catch (error) {
    log('warn', 'segment preflight failed', {
      upstreamUrl: targetUrl.toString(),
      error: errorToLog(error)
    })
    return { checked: false, missing: false }
  }
}

async function preflightSegmentWithRangeGet(targetUrl, req, reasonPrefix = 'preflight range') {
  try {
    const response = await fetchWithTimeout(targetUrl, {
      method: 'GET',
      headers: {
        ...buildUpstreamHeaders(req, targetUrl),
        range: 'bytes=0-0'
      },
      redirect: 'follow'
    })

    storeUpstreamCookies(targetUrl, response.headers)

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel()
      markMissingSegment(targetUrl, `${reasonPrefix}; range ${response.status}`)
      return { checked: true, missing: true }
    }

    if (response.ok || response.status === 206) {
      clearMissingSegment(targetUrl)
      await response.body?.cancel()
      return { checked: true, missing: false }
    }

    await response.body?.cancel()
    log('warn', `segment range preflight returned ${response.status}`, {
      upstreamUrl: targetUrl.toString(),
      upstreamStatus: response.status
    })
    return { checked: false, missing: false }
  } catch (error) {
    log('warn', 'segment range preflight failed', {
      upstreamUrl: targetUrl.toString(),
      error: errorToLog(error)
    })
    return { checked: false, missing: false }
  }
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), preflightTimeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

function isPlaylist(targetUrl, upstream) {
  const contentType = upstream.headers.get('content-type') ?? ''
  if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple.mpegurl')) {
    return true
  }

  if (contentType && !contentType.includes('text/plain') && !contentType.includes('octet-stream')) {
    return false
  }

  return targetUrl.pathname.endsWith('.m3u8')
}

function isPlaylistUrl(targetUrl) {
  return targetUrl.pathname.endsWith('.m3u8')
}

function masterUrlForPlaylist(targetUrl) {
  if (!isPlaylistUrl(targetUrl)) {
    return null
  }

  const sessionId = targetUrl.searchParams.get('sessionId')
  if (!sessionId) {
    return null
  }

  const masterUrl = new URL(targetUrl.toString())
  const pathParts = masterUrl.pathname.split('/')
  pathParts[pathParts.length - 1] = 'index.m3u8'
  masterUrl.pathname = pathParts.join('/')
  masterUrl.search = ''
  masterUrl.searchParams.set('sessionId', sessionId)
  return masterUrl
}

function firstPlaylistUri(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      return trimmed
    }
  }

  return ''
}

function buildUpstreamHeaders(req, targetUrl) {
  const headers = {
    'user-agent': process.env.MEDIA_PROXY_USER_AGENT ?? 'media-proxy/0.1'
  }

  for (const name of ['range', 'accept', 'accept-language']) {
    const value = req.headers[name]
    if (value) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
  }

  const cookie = cookieHeaderFor(targetUrl)
  if (cookie) {
    headers.cookie = cookie
  }

  return headers
}

function buildTargetUrl(requestUrl) {
  const target = requestUrl.searchParams.get('url')
  if (!target) {
    return null
  }

  const targetUrl = new URL(target)

  for (const [name, value] of requestUrl.searchParams) {
    if (name === 'url' || targetUrl.searchParams.has(name)) {
      continue
    }

    targetUrl.searchParams.append(name, value)
  }

  return targetUrl
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

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }

  return Math.floor(parsed)
}

function cookieHeaderFor(targetUrl) {
  const jarKey = cookieJarKey(targetUrl)
  const cookies = cookieJar.get(jarKey)
  if (!cookies) {
    return ''
  }

  const now = Date.now()
  const pairs = []

  for (const [name, cookie] of cookies.entries()) {
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
      cookies.delete(name)
      continue
    }

    pairs.push(`${name}=${cookie.value}`)
  }

  if (cookies.size === 0) {
    cookieJar.delete(jarKey)
  }

  return pairs.join('; ')
}

function storeUpstreamCookies(targetUrl, headers) {
  const setCookieHeaders = getSetCookieHeaders(headers)
  if (setCookieHeaders.length === 0) {
    return
  }

  const jarKey = cookieJarKey(targetUrl)
  const cookies = cookieJar.get(jarKey) ?? new Map()
  const storedNames = []
  const deletedNames = []

  for (const setCookie of setCookieHeaders) {
    const parsed = parseSetCookie(setCookie)
    if (!parsed) {
      continue
    }

    if (parsed.expiresAt !== null && parsed.expiresAt <= Date.now()) {
      cookies.delete(parsed.name)
      deletedNames.push(parsed.name)
      continue
    }

    cookies.set(parsed.name, {
      value: parsed.value,
      expiresAt: parsed.expiresAt
    })
    storedNames.push(parsed.name)
  }

  if (cookies.size > 0) {
    cookieJar.set(jarKey, cookies)
  } else {
    cookieJar.delete(jarKey)
  }

  log('info', `cookies updated origin=${jarKey} stored=${storedNames.length} deleted=${deletedNames.length}`, {
    upstreamOrigin: jarKey,
    storedCookieNames: storedNames,
    deletedCookieNames: deletedNames
  })
}

function cookieJarKey(targetUrl) {
  return targetUrl.origin
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie()
  }

  const value = headers.get('set-cookie')
  return value ? splitSetCookieHeader(value) : []
}

function splitSetCookieHeader(value) {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((item) => item.trim()).filter(Boolean)
}

function parseSetCookie(setCookie) {
  const parts = setCookie.split(';').map((part) => part.trim()).filter(Boolean)
  const nameValue = parts[0]
  const separatorIndex = nameValue?.indexOf('=') ?? -1

  if (separatorIndex <= 0) {
    return null
  }

  const name = nameValue.slice(0, separatorIndex)
  const value = nameValue.slice(separatorIndex + 1)
  let expiresAt = null

  for (const attribute of parts.slice(1)) {
    const attributeSeparatorIndex = attribute.indexOf('=')
    const attributeName = (
      attributeSeparatorIndex >= 0 ? attribute.slice(0, attributeSeparatorIndex) : attribute
    ).toLowerCase()
    const attributeValue = attributeSeparatorIndex >= 0
      ? attribute.slice(attributeSeparatorIndex + 1)
      : ''

    if (attributeName === 'max-age') {
      const seconds = Number(attributeValue)
      if (Number.isFinite(seconds)) {
        expiresAt = Date.now() + seconds * 1000
      }
    } else if (attributeName === 'expires') {
      const timestamp = Date.parse(attributeValue)
      if (!Number.isNaN(timestamp)) {
        expiresAt = timestamp
      }
    }
  }

  return { name, value, expiresAt }
}

function markMissingSegment(targetUrl, reason) {
  const expiresAt = Date.now() + missingSegmentTtlMs
  const keys = missingKeysFor(targetUrl)

  for (const key of keys) {
    missingSegments.set(key, {
      reason,
      url: targetUrl.toString(),
      expiresAt
    })
  }

  log('warn', `missing segment marked gap ${targetUrl.toString()} reason=${reason}`, {
    upstreamUrl: targetUrl.toString(),
    reason,
    missingSegmentCount: missingSegments.size
  })
}

function clearMissingSegment(targetUrl) {
  for (const key of missingKeysFor(targetUrl)) {
    missingSegments.delete(key)
  }
}

function isMissingSegment(url) {
  const targetUrl = new URL(url)
  const now = Date.now()

  for (const key of missingKeysFor(targetUrl)) {
    const entry = missingSegments.get(key)
    if (!entry) {
      continue
    }

    if (entry.expiresAt <= now) {
      missingSegments.delete(key)
      continue
    }

    return true
  }

  return false
}

function missingKeysFor(targetUrl) {
  return [
    targetUrl.toString(),
    mediaSegmentKey(targetUrl.toString())
  ]
}

function cleanupMissingSegments() {
  const now = Date.now()
  for (const [key, entry] of missingSegments.entries()) {
    if (entry.expiresAt <= now) {
      missingSegments.delete(key)
    }
  }
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

  if (isMediaSegmentUrl(targetUrl.toString())) {
    return 'segment'
  }

  return 'resource'
}

function logPlaylistSummary(label, targetUrl, text) {
  const summary = playlistSummary(text)
  const stateKey = `${label}:${targetUrl.toString()}`
  const previous = playlistStates.get(stateKey)
  const unchangedCount = previous &&
    previous.mediaSequence === summary.mediaSequence &&
    previous.lastUri === summary.lastUri
    ? previous.unchangedCount + 1
    : 0

  playlistStates.set(stateKey, {
    mediaSequence: summary.mediaSequence,
    lastUri: summary.lastUri,
    unchangedCount
  })

  log('info', playlistSummaryMessage(label, summary, unchangedCount), {
    upstreamUrl: targetUrl.toString(),
    label,
    ...summary,
    unchangedCount
  })
}

function playlistSummaryMessage(label, summary, unchangedCount) {
  const sequence = summary.mediaSequence ?? '-'
  const targetDuration = summary.targetDuration ?? '-'
  const lastUri = summary.lastUri ?? '-'
  return `${label} kind=${summary.kind} seq=${sequence} target=${targetDuration} ` +
    `uris=${summary.uriCount} last=${lastUri} endlist=${summary.hasEndList} ` +
    `parts=${summary.hasParts} unchanged=${unchangedCount}`
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
  const gapCount = countMatches(rewrittenText, /(^|\n)#EXT-X-GAP(\n|$)/g)

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

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength)}...`
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
