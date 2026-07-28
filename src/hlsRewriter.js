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
  const gapPattern = options.gapPattern ?? /(^|[/"'])gap\.mp4(\?|["']|$)/i
  const onGap = options.onGap ?? null
  const lines = text.split(/\r?\n/)
  const output = []

  for (const line of lines) {
    if (line.trim() === '') {
      output.push(line)
      continue
    }

    if (line.startsWith('#')) {
      output.push(rewriteTagLine(line, sourceUrl, proxyPath, gapPattern, onGap))
      continue
    }

    if (gapPattern.test(line) && output[output.length - 1] !== '#EXT-X-GAP') {
      onGap?.(line)
      output.push('#EXT-X-GAP')
    }

    output.push(toProxyUrl(resolveUrl(line, sourceUrl), proxyPath))
  }

  return output.join('\n')
}

function rewriteTagLine(line, sourceUrl, proxyPath, gapPattern, onGap) {
  const tagName = line.split(':', 1)[0]

  if (!URI_ATTRIBUTE_TAGS.has(tagName) || !line.includes('URI=')) {
    return line
  }

  let rewritten = replaceUriAttributes(line, sourceUrl, proxyPath)

  if (tagName === '#EXT-X-PART' && gapPattern.test(line) && !hasAttribute(line, 'GAP')) {
    onGap?.(line)
    rewritten = `${rewritten},GAP=YES`
  }

  if (tagName === '#EXT-X-PRELOAD-HINT' && gapPattern.test(line)) {
    onGap?.(line)
    return ''
  }

  return rewritten
}

function replaceUriAttributes(line, sourceUrl, proxyPath) {
  return line.replace(/URI=("([^"]*)"|([^,]*))/g, (match, rawValue, quotedValue, plainValue) => {
    const value = quotedValue ?? plainValue

    if (!value) {
      return match
    }

    const proxied = toProxyUrl(resolveUrl(value, sourceUrl), proxyPath)

    if (quotedValue !== undefined) {
      return `URI="${proxied}"`
    }

    return `URI=${proxied}`
  })
}

function hasAttribute(line, name) {
  return new RegExp(`(^|,)${name}=`, 'i').test(line)
}

export function resolveUrl(uri, sourceUrl) {
  return new URL(uri, sourceUrl).toString()
}

export function toProxyUrl(targetUrl, proxyPath = '/proxy') {
  const target = new URL(targetUrl)
  const fileName = target.pathname.split('/').filter(Boolean).at(-1) ?? 'stream'
  return `${proxyPath}/${encodeURIComponent(fileName)}?url=${encodeURIComponent(target.toString())}`
}
