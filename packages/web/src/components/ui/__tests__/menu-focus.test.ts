import { afterEach, describe, expect, it } from "vitest"
import { returnFocusTo } from "../menu-focus"

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
  step(n)
})

afterEach(() => { document.body.innerHTML = "" })

function page() {
  document.body.innerHTML = `
    <div role="dialog" tabindex="-1" id="dialog"><button id="trigger">Options</button><input id="field" /></div>
    <div data-menu-surface id="surface"><button id="item">Item</button></div>`
  const get = (id: string) => document.getElementById(id) as HTMLElement
  return { dialog: get("dialog"), trigger: get("trigger"), field: get("field"), surface: get("surface"), item: get("item") }
}

describe("returnFocusTo", () => {
  it("focuses the trigger when focus has fallen to the body", async () => {
    const { trigger } = page()

    returnFocusTo(trigger)
    await frames(3)

    expect(document.activeElement).toBe(trigger)
  })

  it("waits while focus is still inside the surface that is animating out, and takes it back from the dialog that pulls it in when the surface goes", async () => {
    const { trigger, dialog, surface, item } = page()
    item.focus()

    returnFocusTo(trigger)
    await frames(6)
    expect(document.activeElement).toBe(item)

    // The surface unmounts, and the dialog's focus scope moves focus to the dialog's content.
    surface.remove()
    dialog.focus()
    await frames(3)

    expect(document.activeElement).toBe(trigger)
  })

  it("leaves focus where something deliberate put it, such as a field an item focused", async () => {
    const { trigger, field } = page()
    field.focus()

    returnFocusTo(trigger)
    await frames(4)

    expect(document.activeElement).toBe(field)
  })

  it("gives up on a surface that never goes", async () => {
    const { trigger, item } = page()
    item.focus()

    returnFocusTo(trigger)
    await frames(60)

    expect(document.activeElement).toBe(item)
  })
})
