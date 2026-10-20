import { describe, expect, it } from 'vitest'
import {
  deliveryForSend,
  oppositeDelivery,
  readSendDelivery,
  SEND_DELIVERY_STORAGE_KEY,
  writeSendDelivery,
} from '../send-delivery'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    map,
  }
}

describe('send delivery choice', () => {
  it('defaults to queue when nothing (or something unrecognised) is remembered', () => {
    expect(readSendDelivery(fakeStorage())).toBe('queue')
    expect(readSendDelivery(fakeStorage({ [SEND_DELIVERY_STORAGE_KEY]: 'later' }))).toBe('queue')
    expect(readSendDelivery(null)).toBe('queue')
  })

  it('round-trips the remembered choice', () => {
    const storage = fakeStorage()
    writeSendDelivery(storage, 'now')
    expect(readSendDelivery(storage)).toBe('now')
    writeSendDelivery(storage, 'queue')
    expect(readSendDelivery(storage)).toBe('queue')
  })

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('nope') },
      setItem: () => { throw new Error('nope') },
    }
    expect(readSendDelivery(broken)).toBe('queue')
    expect(() => writeSendDelivery(broken, 'now')).not.toThrow()
  })

  it('flips the standing choice for one send only', () => {
    expect(oppositeDelivery('queue')).toBe('now')
    expect(deliveryForSend('queue', false)).toBe('queue')
    expect(deliveryForSend('queue', true)).toBe('now')
    expect(deliveryForSend('now', true)).toBe('queue')
  })
})
