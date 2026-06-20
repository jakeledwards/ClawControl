import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TopBar } from './TopBar'
import { useStore } from '../store'

// The overflow menu is a presentation-only collapse of the existing header
// controls; these tests exercise its behavior against the real Zustand store.

function seedStore(partial: Record<string, unknown> = {}) {
  useStore.setState({
    connected: true,
    connecting: false,
    thinkingEnabled: false,
    fastModeEnabled: false,
    rightPanelOpen: false,
    showSettings: false,
    sessions: [],
    currentSessionId: null,
    // Stub out the async session patch so the Fast row has no client side effects.
    patchCurrentSession: vi.fn().mockResolvedValue(undefined),
    ...partial,
  } as never)
}

function getTrigger() {
  return screen.getByRole('button', { name: /more controls/i })
}

function openMenu() {
  fireEvent.click(getTrigger())
  return screen.getByRole('menu')
}

describe('TopBar overflow menu', () => {
  beforeEach(() => {
    seedStore()
  })

  it('renders a collapsed overflow trigger with menu semantics', () => {
    render(<TopBar />)
    const trigger = getTrigger()
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('toggles the menu open and closed from the trigger', () => {
    render(<TopBar />)
    const trigger = getTrigger()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu on Escape', () => {
    render(<TopBar />)
    const menu = openMenu()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu when the scrim is clicked', () => {
    const { container } = render(<TopBar />)
    openMenu()
    const scrim = container.querySelector('.overflow-menu-scrim')
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim as Element)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('reflects and toggles Thinking via store state', () => {
    render(<TopBar />)
    openMenu()
    const thinking = screen.getByRole('switch', { name: /thinking/i })
    expect(thinking).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(thinking)
    expect(useStore.getState().thinkingEnabled).toBe(true)
    expect(screen.getByRole('switch', { name: /thinking/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('reflects and toggles Fast, patching the current session', () => {
    render(<TopBar />)
    openMenu()
    const fast = screen.getByRole('switch', { name: /fast/i })
    expect(fast).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(fast)
    expect(useStore.getState().fastModeEnabled).toBe(true)
    expect(useStore.getState().patchCurrentSession).toHaveBeenCalledWith({ fastMode: true })
  })

  it('toggles the Skills panel and closes the menu', () => {
    render(<TopBar />)
    openMenu()
    const skills = screen.getByRole('switch', { name: /skills panel/i })
    expect(skills).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(skills)
    expect(useStore.getState().rightPanelOpen).toBe(true)
    // Toggling the side panel navigates away, so the menu should dismiss.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens Settings and closes the menu', () => {
    render(<TopBar />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /settings/i }))
    expect(useStore.getState().showSettings).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps the menu open while flipping mode switches', () => {
    render(<TopBar />)
    openMenu()
    fireEvent.click(screen.getByRole('switch', { name: /thinking/i }))
    // Switching a mode should not dismiss the lightweight popover.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('shows the active indicator dot when a mode is on', () => {
    seedStore({ thinkingEnabled: true })
    const { container } = render(<TopBar />)
    expect(container.querySelector('.overflow-menu-indicator')).toBeInTheDocument()
  })

  it('hides the active indicator dot when nothing is on', () => {
    const { container } = render(<TopBar />)
    expect(container.querySelector('.overflow-menu-indicator')).not.toBeInTheDocument()
  })
})
