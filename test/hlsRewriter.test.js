import test from 'node:test'
import assert from 'node:assert/strict'
import { rewritePlaylist } from '../src/hlsRewriter.js'

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
