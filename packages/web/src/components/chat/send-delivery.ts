/* How a message sent while a turn is running should arrive: wait for the
 * turn (`queue`) or cut it off (`now`). The choice is the composer's, is
 * remembered across sessions, and Alt+Enter flips it for one send. */

export type SendDelivery = 'queue' | 'now'

export const SEND_DELIVERY_STORAGE_KEY = 'jinn.chatSendDelivery'

/** The remembered choice, defaulting to queue: not interrupting is the
 *  non-destructive arrival, and send-now stays one toggle (or Alt+Enter) away. */
export function readSendDelivery(storage: Pick<Storage, 'getItem'> | null | undefined): SendDelivery {
  try {
    return storage?.getItem(SEND_DELIVERY_STORAGE_KEY) === 'now' ? 'now' : 'queue'
  } catch {
    return 'queue'
  }
}

export function writeSendDelivery(storage: Pick<Storage, 'setItem'> | null | undefined, delivery: SendDelivery): void {
  try {
    storage?.setItem(SEND_DELIVERY_STORAGE_KEY, delivery)
  } catch {
    // A composer that cannot remember still sends; the choice is a convenience.
  }
}

export function oppositeDelivery(delivery: SendDelivery): SendDelivery {
  return delivery === 'queue' ? 'now' : 'queue'
}

/** The delivery one send should use: Alt+Enter flips the standing choice. */
export function deliveryForSend(standing: SendDelivery, flip: boolean): SendDelivery {
  return flip ? oppositeDelivery(standing) : standing
}
