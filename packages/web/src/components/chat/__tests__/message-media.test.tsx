import "@/test/preload-dialogs"
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageMedia } from '../message-media'
import { FALLBACK_RATIO } from '../media-dimensions'
import { stripAttachedFilesBlock } from '@/lib/conversations'
import type { MediaAttachment } from '@/lib/conversations'

// VoiceMessage pulls in audio APIs jsdom lacks; we only test image/file rendering here.
vi.mock('../voice-message', () => ({ VoiceMessage: () => null }))

const mixed: MediaAttachment[] = [
  { type: 'image', url: '/api/files/a', name: 'one.png' },
  { type: 'image', url: '/api/files/b', name: 'two.png' },
  { type: 'image', url: '/api/files/c', name: 'three.png' },
  { type: 'file', url: '/api/files/z', name: 'bundle.zip', size: 2048, mimeType: 'application/zip' },
]

describe('MessageMedia (multi-file)', () => {
  it('renders every image and the file chip without clobbering', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(3)
    expect(screen.getByText('bundle.zip')).toBeTruthy()
    // download links/anchors exist for the file chip (and lightbox provides one when open)
    const dl = screen.getByLabelText('Download bundle.zip') as HTMLAnchorElement
    expect(dl.getAttribute('href')).toBe('/api/files/z')
  })

  it('opens a lightbox with a download link on image click, and closes it', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByLabelText('Open one.png'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    const lightboxDownload = screen.getByLabelText('Download image') as HTMLAnchorElement
    expect(lightboxDownload.getAttribute('href')).toBe('/api/files/a')

    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('portals the lightbox outside a content-visibility message row', () => {
    const { container } = render(
      <div data-message-id="message-1" style={{ contentVisibility: 'auto' }}>
        <MessageMedia media={[mixed[0]]} isUser={false} />
      </div>,
    )

    fireEvent.click(screen.getByLabelText('Open one.png'))

    const messageRow = container.querySelector('[data-message-id="message-1"]')
    const dialog = screen.getByRole('dialog')
    expect(messageRow?.contains(dialog)).toBe(false)
    expect(dialog.closest('[data-slot="dialog-overlay"]')?.parentElement).toBe(document.body)
  })

  it('navigates and wraps a message image gallery with buttons and arrow keys', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    fireEvent.click(screen.getByLabelText('Open one.png'))

    const preview = () => screen.getByTestId('attachment-lightbox-image')
    expect(preview().getAttribute('alt')).toBe('one.png')

    fireEvent.click(screen.getByLabelText('Previous image'))
    expect(preview().getAttribute('alt')).toBe('three.png')
    fireEvent.click(screen.getByLabelText('Next image'))
    expect(preview().getAttribute('alt')).toBe('one.png')

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(preview().getAttribute('alt')).toBe('three.png')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(preview().getAttribute('alt')).toBe('one.png')
  })

  it('renders a single image larger (no grid) without error', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={true} />)
    expect(screen.getAllByRole('img')).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Open one.png'))
    expect(screen.queryByLabelText('Previous image')).toBeNull()
    expect(screen.queryByLabelText('Next image')).toBeNull()
  })

  it('renders a legacy file-typed video as a player instead of a file chip', () => {
    render(<MessageMedia media={[{ type: 'file', url: '/api/files/legacy', name: 'legacy.mp4', mimeType: 'video/mp4' }]} isUser={false} />)

    expect(screen.getByTestId('video-player')).toBeTruthy()
    expect(screen.getByLabelText('Play legacy.mp4')).toBeTruthy()
    expect(screen.queryByText('legacy.mp4')).toBeNull()
  })
})

describe('MessageMedia image loading states', () => {
  it('shows a skeleton before load, then swaps to the image on onLoad', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={false} />)
    // Skeleton placeholder is present while the image loads.
    expect(screen.getByTestId('image-skeleton')).toBeTruthy()
    const img = screen.getByAltText('one.png') as HTMLImageElement
    expect(img).toBeTruthy()
    // After the image fires onLoad, the skeleton is removed (image is revealed).
    fireEvent.load(img)
    expect(screen.queryByTestId('image-skeleton')).toBeNull()
  })

  it('marks thumbnails for native lazy image decoding', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={false} />)

    const img = screen.getByAltText('one.png') as HTMLImageElement
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('decoding')).toBe('async')
  })

  it('renders one skeleton per image in a multi-image grid', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    // 3 images → 3 skeletons before any load fires.
    expect(screen.getAllByTestId('image-skeleton')).toHaveLength(3)
  })

  it('falls back to a broken-image placeholder on error (no infinite skeleton)', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={false} />)
    const img = screen.getByAltText('one.png') as HTMLImageElement
    fireEvent.error(img)
    expect(screen.queryByTestId('image-skeleton')).toBeNull()
    // graceful fallback labelled, original <img> gone
    expect(screen.getByLabelText('one.png (failed to load)')).toBeTruthy()
    expect(screen.queryByAltText('one.png')).toBeNull()
  })
})

/**
 * jsdom computes no layout and drops `aspect-ratio` from a style declaration, so
 * these assert the `--media-ratio` variable the reserved box sizes from — the
 * declared shape, not a measured height. Each test uses its own url because the
 * ratio cache is module-level and outlives a render.
 */
describe('MessageMedia single-image reservation', () => {
  const single = (url: string, name: string): MediaAttachment[] => [{ type: 'image', url, name }]
  const reservedBox = () => screen.getByTestId('image-skeleton').parentElement as HTMLElement
  const declaredRatio = (el: HTMLElement) => el.style.getPropertyValue('--media-ratio')

  function loadWith(img: HTMLImageElement, naturalWidth: number, naturalHeight: number) {
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: naturalHeight, configurable: true })
    fireEvent.load(img)
  }

  it('declares the payload ratio for a never-seen portrait, before anything loads', () => {
    const portrait: MediaAttachment[] = [
      { type: 'image', url: '/api/files/cold-portrait', name: 'portrait.png', width: 600, height: 1200 },
    ]
    render(<MessageMedia media={portrait} isUser={false} />)

    // No load event has fired and this url has never been measured, so the only
    // place 0.5 can come from is the payload — which is the whole point: a tall
    // picture must not reserve a 4:3 box and then grow into its real one.
    const box = reservedBox()
    expect(declaredRatio(box)).toBe('0.5')
    expect(box.className).toContain('aspect-[var(--media-ratio)]')
    expect(screen.getByLabelText('Open portrait.png').className).toContain('w-full')
  })

  it('gives the single-image column a width that does not wait on the picture', () => {
    render(<MessageMedia media={single('/api/files/definite', 'definite.png')} isUser={false} />)

    // The column sits in a bubble that shrinks to its contents, so a percentage
    // width resolves against the text beside it and the reserved box comes out
    // narrow — correct ratio, wrong size — until the decode supplies an intrinsic
    // width and the whole row widens. A declared width is the same before and after.
    const column = (screen.getByLabelText('Open definite.png').parentElement as HTMLElement).classList
    expect(column.contains('w-[var(--chat-media-single,440px)]')).toBe(true)
    expect(column.contains('w-full')).toBe(false)
  })

  it('prefers the payload dimensions over a ratio the cache has already measured', () => {
    const url = '/api/files/payload-wins'
    const first = render(<MessageMedia media={single(url, 'wins.png')} isUser={false} />)
    loadWith(screen.getByAltText('wins.png') as HTMLImageElement, 1000, 400)
    first.unmount()

    render(
      <MessageMedia media={[{ type: 'image', url, name: 'wins.png', width: 600, height: 1200 }]} isUser={false} />,
    )
    expect(declaredRatio(reservedBox())).toBe('0.5')
  })

  it('keeps the payload ratio when the decode reports a different shape', () => {
    const url = '/api/files/payload-survives'
    render(<MessageMedia media={[{ type: 'image', url, name: 'survives.png', width: 600, height: 1200 }]} isUser={false} />)
    const img = screen.getByAltText('survives.png') as HTMLImageElement

    // The load is a reserved box's one chance to be wrong: the server measured this
    // picture off the bytes, so a decode that disagrees must not move a box the
    // reader is already looking at.
    loadWith(img, 1000, 400)
    expect(declaredRatio(img.parentElement as HTMLElement)).toBe('0.5')
  })

  it('falls back when a payload carries a dimension nothing can be divided by', () => {
    render(
      <MessageMedia
        media={[{ type: 'image', url: '/api/files/zero-height', name: 'zero-height.png', width: 600, height: 0 }]}
        isUser={false}
      />,
    )
    expect(declaredRatio(reservedBox())).toBe(String(FALLBACK_RATIO))
  })

  it('declares a fallback-ratio box for an unseen url instead of a flat minHeight', () => {
    render(<MessageMedia media={single('/api/files/unseen', 'unseen.png')} isUser={false} />)

    const box = reservedBox()
    expect(declaredRatio(box)).toBe(String(FALLBACK_RATIO))
    // The variable is only a number until something sizes from it: without the
    // class the box reserves nothing and the ratio assertion above still passes.
    expect(box.className).toContain('aspect-[var(--media-ratio)]')
    expect(box.style.minHeight).toBe('')
  })

  it('declares the true ratio of a seen url on first paint of the next render, with no load', () => {
    const media = single('/api/files/remembered', 'remembered.png')
    const first = render(<MessageMedia media={media} isUser={false} />)
    loadWith(screen.getByAltText('remembered.png') as HTMLImageElement, 800, 1000)
    first.unmount()

    render(<MessageMedia media={media} isUser={false} />)
    expect(declaredRatio(reservedBox())).toBe(String(800 / 1000))
  })

  it('ignores a zero-sized load so a later render still declares the fallback', () => {
    const media = single('/api/files/zero-sized', 'zero.png')
    const first = render(<MessageMedia media={media} isUser={false} />)
    loadWith(screen.getByAltText('zero.png') as HTMLImageElement, 0, 0)
    first.unmount()

    render(<MessageMedia media={media} isUser={false} />)
    expect(declaredRatio(reservedBox())).toBe(String(FALLBACK_RATIO))
  })

  it('stretches the opener to the media column so the ratio has a width to resolve against', () => {
    render(<MessageMedia media={single('/api/files/stretched', 'stretched.png')} isUser={false} />)

    // The reserved box is `width: 100%` of this button, and a button sizes to its
    // contents unless told otherwise — so without the stretch the percentage
    // resolves against nothing and the box reserves zero height, however correct
    // its declared ratio is.
    expect(screen.getByLabelText('Open stretched.png').className).toContain('w-full')
  })

  it('fills the reserved box without cropping', () => {
    render(<MessageMedia media={single('/api/files/contained', 'contained.png')} isUser={false} />)

    const img = screen.getByAltText('contained.png')
    expect(img.className).toContain('object-contain')
    expect(img.className).toContain('h-full')
    expect(img.className).toContain('w-full')
  })

  it('leaves grid tiles at their fixed height and crop', () => {
    const pair: MediaAttachment[] = [
      { type: 'image', url: '/api/files/grid-1', name: 'grid-one.png' },
      { type: 'image', url: '/api/files/grid-2', name: 'grid-two.png' },
    ]
    render(<MessageMedia media={pair} isUser={false} />)

    const img = screen.getByAltText('grid-one.png')
    expect(img.className).toContain('object-cover')
    expect(img.className).toContain('h-[130px]')
    const tile = screen.getAllByTestId('image-skeleton')[0].parentElement as HTMLElement
    expect(declaredRatio(tile)).toBe('')
  })

  it('gives the error tile the same reserved box as the loading state', () => {
    render(<MessageMedia media={single('/api/files/broken', 'broken.png')} isUser={false} />)
    const reserved = declaredRatio(reservedBox())
    expect(reserved).toBe(String(FALLBACK_RATIO))

    fireEvent.error(screen.getByAltText('broken.png'))

    const tile = screen.getByLabelText('broken.png (failed to load)')
    expect(declaredRatio(tile)).toBe(reserved)
    expect(tile.className).toContain('aspect-[var(--media-ratio)]')
    expect(tile.className).not.toContain('h-[140px]')
  })
})

describe('stripAttachedFilesBlock', () => {
  it('removes the appended engine-only Attached files block', () => {
    const text = 'Please analyze this\n\nAttached files:\n- /home/a/.jinn/uploads/2026-05-30/s/report.pdf'
    expect(stripAttachedFilesBlock(text)).toBe('Please analyze this')
  })
  it('removes a multi-path block', () => {
    const text = 'hi\n\nAttached files:\n- /a/one.png\n- /a/two.zip'
    expect(stripAttachedFilesBlock(text)).toBe('hi')
  })
  it('leaves normal text untouched', () => {
    expect(stripAttachedFilesBlock('just a message')).toBe('just a message')
  })
})
