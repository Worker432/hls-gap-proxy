import test from 'node:test'
import assert from 'node:assert/strict'
import {
  liveEdgeSegmentUrls,
  mediaSegmentKey,
  playlistSummary,
  rewritePlaylist
} from '../src/hlsRewriter.js'

test('rewrites media playlist segment uris through proxy', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:10',
    '#EXTINF:1.00000,',
    'segment1.mp4?sessionId=abc',
    ''
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc'
  )

  assert.match(
    result,
    /\/proxy\/segment1\.mp4\?url=https%3A%2F%2Fvideo\.umkey\.ru%3A8888%2Fcamera%2Fsegment1\.mp4%3FsessionId%3Dabc/
  )
})

test('marks gap media segment with EXT-X-GAP', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:1.00000,',
    'gap.mp4',
    '#EXTINF:1.00000,',
    'segment2.mp4'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc'
  )

  assert.match(result, /#EXTINF:1\.00000,\n#EXT-X-GAP\n\/proxy\/gap\.mp4\?url=/)
})

test('marks known missing media segment with EXT-X-GAP', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:1.00000,',
    'segment1.ts?sessionId=abc',
    '#EXTINF:1.00000,',
    'segment2.ts?sessionId=abc'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc',
    {
      isGapUrl: (url) => mediaSegmentKey(url).endsWith('/segment2.ts')
    }
  )

  assert.match(
    result,
    /segment1\.ts[\s\S]*#EXTINF:1\.00000,\n#EXT-X-GAP\n\/proxy\/segment2\.ts\?url=/
  )
})

test('rewrites master playlist stream uris', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1527439,CODECS="avc1.4d0029"',
    'video1_stream.m3u8?sessionId=abc'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/index.m3u8?sessionId=abc'
  )

  assert.match(
    result,
    /\/proxy\/video1_stream\.m3u8\?url=https%3A%2F%2Fvideo\.umkey\.ru%3A8888%2Fcamera%2Fvideo1_stream\.m3u8%3FsessionId%3Dabc/
  )
})

test('rewrites playlist uris with proxy base url', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1527439,CODECS="avc1.4d0029"',
    'video1_stream.m3u8?sessionId=abc'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/index.m3u8?sessionId=abc',
    {
      proxyBaseUrl: 'http://localhost:8090'
    }
  )

  assert.match(
    result,
    /http:\/\/localhost:8090\/proxy\/video1_stream\.m3u8\?url=https%3A%2F%2Fvideo\.umkey\.ru%3A8888%2Fcamera%2Fvideo1_stream\.m3u8%3FsessionId%3Dabc/
  )
})

test('trims live media playlist to live edge segment count', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:4',
    '#EXTINF:10.000,',
    'segment4.ts?sessionId=abc',
    '#EXTINF:10.000,',
    'segment5.ts?sessionId=abc',
    '#EXTINF:10.000,',
    'segment6.ts?sessionId=abc',
    '#EXTINF:10.000,',
    'segment7.ts?sessionId=abc'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc',
    {
      liveEdgeSegmentCount: 2
    }
  )

  assert.match(result, /#EXT-X-MEDIA-SEQUENCE:6/)
  assert.doesNotMatch(result, /segment4\.ts/)
  assert.doesNotMatch(result, /segment5\.ts/)
  assert.match(result, /segment6\.ts/)
  assert.match(result, /segment7\.ts/)
})

test('does not trim vod media playlist with ENDLIST', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10.000,',
    'segment0.ts',
    '#EXTINF:10.000,',
    'segment1.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/archive.m3u8',
    {
      liveEdgeSegmentCount: 1
    }
  )

  assert.match(result, /segment0\.ts/)
  assert.match(result, /segment1\.ts/)
  assert.match(result, /#EXT-X-ENDLIST/)
})

test('returns live edge segment urls for preflight', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10.000,',
    'segment0.ts?sessionId=abc',
    '#EXTINF:10.000,',
    'segment1.ts?sessionId=abc',
    '#EXTINF:10.000,',
    'segment2.ts?sessionId=abc'
  ].join('\n')

  const urls = liveEdgeSegmentUrls(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc',
    2
  )

  assert.deepEqual(urls, [
    'https://video.umkey.ru:8888/camera/segment1.ts?sessionId=abc',
    'https://video.umkey.ru:8888/camera/segment2.ts?sessionId=abc'
  ])
})

test('summarizes playlists for diagnostics', () => {
  const summary = playlistSummary([
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MEDIA-SEQUENCE:3',
    '#EXTINF:10.000,',
    'segment3.ts'
  ].join('\n'))

  assert.equal(summary.kind, 'media')
  assert.equal(summary.mediaSequence, 3)
  assert.equal(summary.targetDuration, 10)
  assert.equal(summary.uriCount, 1)
  assert.equal(summary.lastUri, 'segment3.ts')
})

test('rewrites URI attributes and marks gap parts', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4?sessionId=abc"',
    '#EXT-X-PART:DURATION=0.32000,URI="gap.mp4"'
  ].join('\n')

  const result = rewritePlaylist(
    playlist,
    'https://video.umkey.ru:8888/camera/video1_stream.m3u8?sessionId=abc'
  )

  assert.match(result, /#EXT-X-MAP:URI="\/proxy\/init\.mp4\?url=/)
  assert.match(result, /#EXT-X-PART:DURATION=0\.32000,URI="\/proxy\/gap\.mp4\?url=.*",GAP=YES/)
})
