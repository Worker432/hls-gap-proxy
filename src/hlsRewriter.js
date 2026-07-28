const URI_ATTRIBUTE_TAGS = new Set([
  '#EXT-X-MAP',
  '#EXT-X-PART',
  '#EXT-X-PRELOAD-HINT',
  '#EXT-X-RENDITION-REPORT',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-MEDIA',
  '#EXT-X-SESSION-DATA',
  '#EXT-X-SESSION-KEY'
])

export function rewritePlaylist(text, sourceUrl, options = {}) {
  const proxyPath = options.proxyPath ?? '/proxy'
  const proxyBaseUrl = options.proxyBaseUrl ?? ''
  const gapPattern = options.gapPattern ?? /(^|[/"'])gap\.mp4(\?|["']|$)/i
  const isGapUrl = options.isGapUrl ?? null
  const onGap = options.onGap ?? null
  const liveEdgeSegmentCount = options.liveEdgeSegmentCount ?? 0
  const lines = trimLiveMediaPlaylist(
    text.split(/\r?\n/),
    liveEdgeSegmentCount
  )
  const output = []

  for (const line of lines) {
    if (line.trim() === '') {
      output.push(line)
      continue
    }

    if (line.startsWith('#')) {
      output.push(rewriteTagLine(line, sourceUrl, proxyPath, proxyBaseUrl, gapPattern, isGapUrl, onGap))
      continue
    }

    const resolvedUrl = resolveUrl(line, sourceUrl)
    if ((gapPattern.test(line) || isGapUrl?.(resolvedUrl)) && output[output.length - 1] !== '#EXT-X-GAP') {
      onGap?.(line)
      output.push('#EXT-X-GAP')
    }

    output.push(toProxyUrl(resolvedUrl, proxyPath, proxyBaseUrl))
  }

  return output.join('\n')
}

export function playlistSummary(text) {
  const lines = text.split(/\r?\n/)
  const uris = []
  const streams = []
  let mediaSequence = null
  let targetDuration = null
  let hasEndList = false
  let hasParts = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      continue
    }

    if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(trimmed.slice('#EXT-X-MEDIA-SEQUENCE:'.length))
    } else if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(trimmed.slice('#EXT-X-TARGETDURATION:'.length))
    } else if (trimmed === '#EXT-X-ENDLIST') {
      hasEndList = true
    } else if (trimmed.startsWith('#EXT-X-PART:')) {
      hasParts = true
    } else if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
      streams.push(trimmed)
    } else if (!trimmed.startsWith('#')) {
      uris.push(trimmed)
    }
  }

  return {
    kind: streams.length > 0 ? 'master' : 'media',
    mediaSequence,
    targetDuration,
    uriCount: uris.length,
    firstUri: uris[0] ?? null,
    lastUri: uris.at(-1) ?? null,
    hasEndList,
    hasParts
  }
}

export function liveEdgeSegmentUrls(text, sourceUrl, liveEdgeSegmentCount) {
  const lines = trimLiveMediaPlaylist(
    text.split(/\r?\n/),
    liveEdgeSegmentCount
  )

  if (!isLiveMediaPlaylist(lines)) {
    return []
  }

  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => resolveUrl(line, sourceUrl))
    .filter(isMediaSegmentUrl)
}

function rewriteTagLine(line, sourceUrl, proxyPath, proxyBaseUrl, gapPattern, isGapUrl, onGap) {
  const tagName = line.split(':', 1)[0]

  if (!URI_ATTRIBUTE_TAGS.has(tagName) || !line.includes('URI=')) {
    return line
  }

  let rewritten = replaceUriAttributes(line, sourceUrl, proxyPath, proxyBaseUrl)
  const hasGapUri = uriAttributes(line)
    .map((uri) => resolveUrl(uri, sourceUrl))
    .some((uri) => isGapUrl?.(uri))

  if (tagName === '#EXT-X-PART' && (gapPattern.test(line) || hasGapUri) && !hasAttribute(line, 'GAP')) {
    onGap?.(line)
    rewritten = `${rewritten},GAP=YES`
  }

  if (tagName === '#EXT-X-PRELOAD-HINT' && (gapPattern.test(line) || hasGapUri)) {
    onGap?.(line)
    return ''
  }

  return rewritten
}

function replaceUriAttributes(line, sourceUrl, proxyPath, proxyBaseUrl) {
  return line.replace(/URI=("([^"]*)"|([^,]*))/g, (match, rawValue, quotedValue, plainValue) => {
    const value = quotedValue ?? plainValue

    if (!value) {
      return match
    }

    const proxied = toProxyUrl(resolveUrl(value, sourceUrl), proxyPath, proxyBaseUrl)

    if (quotedValue !== undefined) {
      return `URI="${proxied}"`
    }

    return `URI=${proxied}`
  })
}

function trimLiveMediaPlaylist(lines, liveEdgeSegmentCount) {
  if (liveEdgeSegmentCount <= 0 || !isLiveMediaPlaylist(lines)) {
    return lines
  }

  const uriIndexes = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line !== '' && !line.startsWith('#'))
    .map(({ index }) => index)

  if (uriIndexes.length <= liveEdgeSegmentCount) {
    return lines
  }

  const droppedSegmentCount = uriIndexes.length - liveEdgeSegmentCount
  const previousUriIndex = uriIndexes[droppedSegmentCount - 1]
  const firstUriIndex = uriIndexes[0]
  const headerEndIndex = findSegmentStart(lines, firstUriIndex)
  const keepStartIndex = previousUriIndex + 1
  const header = updateMediaSequence(lines.slice(0, headerEndIndex), droppedSegmentCount)
  const body = lines.slice(keepStartIndex)

  return header.concat(body)
}

function isLiveMediaPlaylist(lines) {
  let hasStreamInf = false
  let hasEndList = false
  let hasUri = false

  for (const line of lines) {
    const trimmed = line.trim()
    hasStreamInf = hasStreamInf || trimmed.startsWith('#EXT-X-STREAM-INF:')
    hasEndList = hasEndList || trimmed === '#EXT-X-ENDLIST'
    hasUri = hasUri || (trimmed !== '' && !trimmed.startsWith('#'))
  }

  return hasUri && !hasStreamInf && !hasEndList
}

function findSegmentStart(lines, uriIndex) {
  let index = uriIndex

  while (index > 0 && isSegmentTag(lines[index - 1])) {
    index -= 1
  }

  return index
}

function isSegmentTag(line) {
  const trimmed = line.trim()
  return trimmed === '' ||
    trimmed.startsWith('#EXTINF') ||
    trimmed.startsWith('#EXT-X-BYTERANGE') ||
    trimmed.startsWith('#EXT-X-PROGRAM-DATE-TIME') ||
    trimmed.startsWith('#EXT-X-DATERANGE') ||
    trimmed.startsWith('#EXT-X-DISCONTINUITY') ||
    trimmed.startsWith('#EXT-X-GAP') ||
    trimmed.startsWith('#EXT-X-PART')
}

function updateMediaSequence(lines, droppedSegmentCount) {
  return lines.map((line) => {
    const prefix = '#EXT-X-MEDIA-SEQUENCE:'
    if (!line.startsWith(prefix)) {
      return line
    }

    const sequence = Number(line.slice(prefix.length))
    if (!Number.isFinite(sequence)) {
      return line
    }

    return `${prefix}${sequence + droppedSegmentCount}`
  })
}

function hasAttribute(line, name) {
  return new RegExp(`(^|,)${name}=`, 'i').test(line)
}

function uriAttributes(line) {
  return Array.from(line.matchAll(/URI=("([^"]*)"|([^,]*))/g))
    .map((match) => match[2] ?? match[3])
    .filter(Boolean)
}

export function resolveUrl(uri, sourceUrl) {
  return new URL(uri, sourceUrl).toString()
}

export function toProxyUrl(targetUrl, proxyPath = '/proxy', proxyBaseUrl = '') {
  const target = new URL(targetUrl)
  const fileName = target.pathname.split('/').filter(Boolean).at(-1) ?? 'stream'
  return `${proxyBaseUrl}${proxyPath}/${encodeURIComponent(fileName)}?url=${encodeURIComponent(target.toString())}`
}

export function mediaSegmentKey(url) {
  const target = new URL(url)
  return `${target.origin}${target.pathname}`
}

export function isMediaSegmentUrl(url) {
  const target = new URL(url)
  return ['.ts', '.mp4', '.m4s', '.cmfv', '.cmfa'].some((extension) =>
    target.pathname.endsWith(extension)
  )
}
