import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMediaIdCache, isOwnStorageLink, sendMediaMessage, sendTemplateMessage } from './meta-api'
import type { MessageTemplate } from '@/types'

const OWN = 'https://proj.supabase.co/storage/v1/object/public/chat-media/nurture/v.mp4'
const OTHER = 'https://cdn.example.com/v.mp4'

type Call = { url: string; init?: RequestInit }
let calls: Call[]

function fakeFetch(opts: { uploadOk?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === OWN) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })
    if (url.endsWith('/media')) {
      return opts.uploadOk === false
        ? new Response('{}', { status: 500 })
        : Response.json({ id: 'MEDIA123' })
    }
    return Response.json({ messages: [{ id: 'wamid.X' }] })
  })
}

const sentBody = () => JSON.parse(calls.filter((c) => c.url.endsWith('/messages')).at(-1)!.init!.body as string)
const BASE = { phoneNumberId: 'pn1', accessToken: 'tok', to: '919876543210' }
const template = {
  name: 't', header_type: 'video', header_media_url: OWN, body_text: 'Hi', buttons: [],
} as unknown as MessageTemplate

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
  calls = []
  __resetMediaIdCache()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upload-once media', () => {
  it('recognises only public links on our own Supabase host', () => {
    expect(isOwnStorageLink(OWN)).toBe(true)
    expect(isOwnStorageLink(OTHER)).toBe(false)
    expect(isOwnStorageLink('https://proj.supabase.co/rest/v1/x')).toBe(false)
  })

  it('downloads and uploads a storage video once for many template sends', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    for (let i = 0; i < 5; i++) await sendTemplateMessage({ ...BASE, templateName: 't', template })

    expect(calls.filter((c) => c.url === OWN)).toHaveLength(1)
    expect(calls.filter((c) => c.url.endsWith('/media'))).toHaveLength(1)
    expect(sentBody().template.components[0].parameters[0]).toEqual({ type: 'video', video: { id: 'MEDIA123' } })
  })

  it('shares one upload between simultaneous sends', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    await Promise.all([1, 2, 3].map(() => sendTemplateMessage({ ...BASE, templateName: 't', template })))
    expect(calls.filter((c) => c.url.endsWith('/media'))).toHaveLength(1)
  })

  it('falls back to the link when the upload fails', async () => {
    vi.stubGlobal('fetch', fakeFetch({ uploadOk: false }))
    await sendTemplateMessage({ ...BASE, templateName: 't', template })
    expect(sentBody().template.components[0].parameters[0]).toEqual({ type: 'video', video: { link: OWN } })
  })

  it('leaves links on other hosts alone', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    await sendMediaMessage({ ...BASE, kind: 'video', link: OTHER })
    expect(calls).toHaveLength(1)
    expect(sentBody().video).toEqual({ link: OTHER })
  })

  it('sends media messages from storage by id', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    await sendMediaMessage({ ...BASE, kind: 'video', link: OWN, caption: 'hi' })
    expect(sentBody().video).toEqual({ id: 'MEDIA123', caption: 'hi' })
  })
})
