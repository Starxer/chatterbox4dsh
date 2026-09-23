import { describe, expect, it } from 'vitest'
import {
  classifyMedia,
  sniffAudioContainer,
  sniffAudioFormat,
  sniffImageMime,
  sniffVideoContainer,
} from '../src/media-sniff.ts'
import { ftypBox, mp4Bytes as mp4, oggBytes } from './stubs/media-bytes.ts'

const ogg = oggBytes

describe('sniffVideoContainer', () => {
  it('accepts an MP4 whose video track is H.264', () => {
    expect(sniffVideoContainer(mp4())).toEqual({ container: 'mp4', codec: 'avc1' })
  })

  it('accepts QuickTime containers (macOS screen recordings are H.264 .mov)', () => {
    expect(sniffVideoContainer(mp4({ major: 'qt  ', compatible: ['qt  '] })))
      .toEqual({ container: 'mov', codec: 'avc1' })
  })

  it('accepts an MP4 brand that only appears in the compatible-brands list', () => {
    expect(sniffVideoContainer(mp4({ major: '3gp4', compatible: ['isom', 'mp42'] }))?.container).toBe('mp4')
  })

  it('accepts HEVC and MPEG-4 part 2 codecs', () => {
    expect(sniffVideoContainer(mp4({ codec: 'hvc1' }))?.codec).toBe('hvc1')
    expect(sniffVideoContainer(mp4({ codec: 'hev1' }))?.codec).toBe('hev1')
    expect(sniffVideoContainer(mp4({ codec: 'mp4v' }))?.codec).toBe('mp4v')
  })

  it('rejects a codec Feishu clients cannot play (ProRes keeps the file path)', () => {
    expect(sniffVideoContainer(mp4({ codec: 'apcn' }))).toBeUndefined()
    expect(sniffVideoContainer(mp4({ codec: 'vp09' }))).toBeUndefined()
  })

  it('rejects an audio-only MP4 track', () => {
    expect(sniffVideoContainer(mp4({ codec: 'mp4a' }))).toBeUndefined()
  })

  it('rejects a container the SDK could not measure (no mvhd)', () => {
    expect(sniffVideoContainer(mp4({ mvhd: false }))).toBeUndefined()
  })

  it('rejects bytes with no ftyp / moov at all', () => {
    expect(sniffVideoContainer(Buffer.from('hello world, definitely not a video'))).toBeUndefined()
    expect(sniffVideoContainer(Buffer.alloc(0))).toBeUndefined()
    expect(sniffVideoContainer(Buffer.concat([ftypBox('isom'), Buffer.from('not a box')]))).toBeUndefined()
  })

  it('rejects a truncated ftyp header without throwing', () => {
    const full = mp4()
    expect(sniffVideoContainer(full.subarray(0, 10))).toBeUndefined()
    expect(sniffVideoContainer(full.subarray(0, 40))).toBeUndefined()
  })
})

describe('sniffAudioContainer', () => {
  it('accepts Ogg/Opus (the only shape Feishu renders as a voice bubble)', () => {
    expect(sniffAudioContainer(ogg('OpusHead'))).toBe('opus')
  })

  it('rejects Ogg without an Opus stream, and non-Ogg audio', () => {
    expect(sniffAudioContainer(ogg('vorbis'))).toBeUndefined()
    expect(sniffAudioContainer(Buffer.from('ID3\u0003'))).toBeUndefined()
    expect(sniffAudioContainer(mp4())).toBeUndefined()
  })
})

describe('sniffImageMime', () => {
  it('still types images from their magic bytes', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(mp4())).toBeUndefined()
    expect(sniffAudioContainer(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
  })
})

describe('sniffAudioFormat', () => {
  const wav = (): Buffer => {
    const bytes = Buffer.alloc(44)
    bytes.write('RIFF', 0, 'latin1')
    bytes.write('WAVE', 8, 'latin1')
    return bytes
  }

  it('recognises the containers a card audio player would need transcoded', () => {
    expect(sniffAudioFormat(ogg('OpusHead'))).toBe('opus')
    expect(sniffAudioFormat(wav())).toBe('wav')
    expect(sniffAudioFormat(Buffer.from('fLaC\u0000\u0000\u0000"'))).toBe('flac')
    expect(sniffAudioFormat(Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000'))).toBe('mp3')
    // Raw MPEG audio frame sync, no ID3 tag.
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3')
  })

  it('reads an audio-only ISO-BMFF file as m4a', () => {
    expect(sniffAudioFormat(mp4({ codec: 'mp4a' }))).toBe('m4a')
  })

  it('does not mistake video for audio', () => {
    expect(sniffAudioFormat(mp4())).toBeUndefined()
    // an MP4 whose video codec Feishu cannot play is still video, not audio
    expect(sniffAudioFormat(mp4({ codec: 'vp09' }))).toBeUndefined()
    expect(sniffAudioFormat(Buffer.from('plain text'))).toBeUndefined()
  })
})

describe('classifyMedia', () => {
  it('classifies images, playable video and audio apart', () => {
    expect(classifyMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ kind: 'image' })
    expect(classifyMedia(mp4())).toEqual({ kind: 'video', video: { container: 'mp4', codec: 'avc1' } })
    expect(classifyMedia(mp4({ codec: 'mp4a' }))).toEqual({ kind: 'audio', audio: 'm4a' })
  })

  it('leaves anything else (and unplayable video codecs) uncategorised', () => {
    expect(classifyMedia(mp4({ codec: 'vp09' }))).toBeUndefined()
    expect(classifyMedia(Buffer.from('# just markdown'))).toBeUndefined()
  })
})
