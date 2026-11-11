import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { AccountsError } from "@/lib/accounts-api"
import { PairingScreen } from "./pairing-screen"
import { SignInForm } from "./sign-in-form"

const state = { authRequired: true, authenticated: false, canBootstrapLocal: false, networkExposed: false }

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } })
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }))
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("SignInForm", () => {
  it("submits the trimmed email and the password as typed", async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined)
    render(<SignInForm onSignIn={onSignIn} />)
    fill("  person@example.test ", " keep my spaces ")
    await submit()
    expect(onSignIn).toHaveBeenCalledWith("person@example.test", " keep my spaces ")
  })

  it("does not submit until both fields have something in them", async () => {
    const onSignIn = vi.fn()
    render(<SignInForm onSignIn={onSignIn} />)
    fill("person@example.test", "")
    expect((screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it("says the same thing for any 401, whatever the server's wording", async () => {
    const onSignIn = vi.fn().mockRejectedValue(new AccountsError(401, "No such account"))
    render(<SignInForm onSignIn={onSignIn} />)
    fill("person@example.test", "wrong password here")
    await submit()
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("Email or password is incorrect")
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true")
  })

  it("shows other failures as the server worded them and lets the person retry", async () => {
    const onSignIn = vi.fn().mockRejectedValueOnce(new AccountsError(500, "The gateway is busy")).mockResolvedValue(undefined)
    render(<SignInForm onSignIn={onSignIn} />)
    fill("person@example.test", "a long enough password")
    await submit()
    expect((await screen.findByRole("alert")).textContent).toBe("The gateway is busy")
    await submit()
    expect(onSignIn).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  describe("when rate limited", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it("names the wait, counts it down, and re-enables submit when it ends", async () => {
      const onSignIn = vi.fn().mockRejectedValue(new AccountsError(429, "Too many", 3))
      render(<SignInForm onSignIn={onSignIn} />)
      fill("person@example.test", "a long enough password")
      await submit()

      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 3 seconds.")
      const button = screen.getByRole("button", { name: /^sign in$/i }) as HTMLButtonElement
      expect(button.disabled).toBe(true)

      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 2 seconds.")

      await act(async () => { vi.advanceTimersByTime(2000) })
      expect(screen.queryByRole("alert")).toBeNull()
      expect(button.disabled).toBe(false)
    })

    it("words a long wait in minutes", async () => {
      const onSignIn = vi.fn().mockRejectedValue(new AccountsError(429, "Too many", 900))
      render(<SignInForm onSignIn={onSignIn} />)
      fill("person@example.test", "a long enough password")
      await submit()
      expect(screen.getByRole("alert").textContent).toBe("Too many attempts. Try again in 15 minutes.")
    })
  })
})

describe("PairingScreen sign-in offer", () => {
  it("offers the email form beside pairing when the gate can sign in", () => {
    render(<PairingScreen authState={state} pairing={false} onPair={() => {}} onSignIn={async () => {}} />)
    expect(screen.getByRole("form", { name: /sign in/i })).toBeTruthy()
    expect(screen.getByLabelText(/remote access code/i)).toBeTruthy()
  })

  it("is the pairing screen it always was without onSignIn", () => {
    render(<PairingScreen authState={state} pairing={false} onPair={() => {}} />)
    expect(screen.queryByRole("form", { name: /sign in/i })).toBeNull()
    expect(screen.queryByLabelText("Email")).toBeNull()
    expect(screen.getByRole("heading", { name: "Pair This Browser" })).toBeTruthy()
  })
})
