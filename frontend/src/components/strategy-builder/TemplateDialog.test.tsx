import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { STRATEGY_TEMPLATES } from '@/lib/strategyTemplates'
import type { OptionStrike } from '@/types/option-chain'
import { TemplateDialog, type TemplateDialogProps } from './TemplateDialog'

expect.extend(toHaveNoViolations)

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TemplateDialog payoff topology guard', () => {
  it('SB-18 labels strike, expiry, lot, and icon controls without accessibility violations', async () => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === 'long_call')
    const chain: OptionStrike[] = [
      { strike: 100, ce: { symbol: 'CALL100', ltp: 5 } as OptionStrike['ce'], pe: null },
    ]

    const view = render(
      <TemplateDialog
        open
        onOpenChange={vi.fn()}
        template={template ?? null}
        expiry="04AUG26"
        expiries={['04AUG26']}
        onExpiryChange={vi.fn()}
        chain={chain}
        atmStrike={100}
        strikeStep={10}
        onConfirm={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Long Call' })
    expect(within(dialog).getByRole('combobox', { name: /strike for buy call leg 1/i })).toBeVisible()
    expect(within(dialog).getByRole('combobox', { name: /strategy expiry/i })).toBeVisible()
    expect(within(dialog).getByRole('spinbutton', { name: /strategy lot quantity/i })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /decrease strategy lots/i })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /increase strategy lots/i })).toBeVisible()
    expect(await axe(view.container)).toHaveNoViolations()
  })

  it('PG-22 disables Add Strategy when an offset is outside the loaded chain', () => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === 'batman_strategy')
    const chain: OptionStrike[] = [90, 100, 110].map((strike) => ({
      strike,
      ce: null,
      pe: null,
    }))

    render(
      <TemplateDialog
        open
        onOpenChange={vi.fn()}
        template={template ?? null}
        expiry="04-AUG-2026"
        expiries={['04-AUG-2026']}
        onExpiryChange={vi.fn()}
        chain={chain}
        atmStrike={100}
        strikeStep={10}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/outside the loaded option chain/i)
    expect(screen.getByRole('button', { name: 'Add Strategy' })).toBeDisabled()
  })

  it('PG-21 disables a calendar instead of collapsing both legs into one expiry', () => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === 'call_calendar')
    const chain: OptionStrike[] = [90, 100, 110].map((strike) => ({
      strike,
      ce: { symbol: `CALL${strike}`, ltp: 5 } as OptionStrike['ce'],
      pe: null,
    }))

    render(
      <TemplateDialog
        open
        onOpenChange={vi.fn()}
        template={template ?? null}
        expiry="04AUG26"
        expiries={['04AUG26']}
        onExpiryChange={vi.fn()}
        chain={chain}
        atmStrike={100}
        strikeStep={10}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/later expiry is required/i)
    expect(screen.getByRole('combobox', { name: /strategy expiry/i })).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    for (const strike of screen.getAllByRole('combobox', { name: /strike for/i })) {
      expect(strike).toHaveAttribute('aria-invalid', 'false')
    }
    expect(screen.getByRole('button', { name: 'Add Strategy' })).toBeDisabled()
  })

  it('PG-22 disables a template when its required CE or PE contract is missing', () => {
    const template = STRATEGY_TEMPLATES.find((item) => item.id === 'long_call')
    const chain: OptionStrike[] = [{ strike: 100, ce: null, pe: null }]

    render(
      <TemplateDialog
        open
        onOpenChange={vi.fn()}
        template={template ?? null}
        expiry="04AUG26"
        expiries={['04AUG26']}
        onExpiryChange={vi.fn()}
        chain={chain}
        atmStrike={100}
        strikeStep={10}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/required CE contract/i)
    expect(screen.getByRole('combobox', { name: /strike for buy call leg 1/i })).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(screen.getByRole('combobox', { name: /strategy expiry/i })).toHaveAttribute(
      'aria-invalid',
      'false'
    )
    expect(screen.getByRole('button', { name: 'Add Strategy' })).toBeDisabled()
  })
})

describe('TemplateDialog open strike list', () => {
  const STRIKES = [80, 90, 100, 110, 120]

  /** Fresh array and fresh rows each call, as every live chain tick delivers. */
  function freshChain(strikes: number[]): OptionStrike[] {
    return strikes.map((strike) => ({
      strike,
      ce: { symbol: `CALL${strike}`, ltp: 5 } as OptionStrike['ce'],
      pe: null,
    }))
  }

  function dialogProps(chain: OptionStrike[]): TemplateDialogProps {
    return {
      open: true,
      onOpenChange: vi.fn(),
      template: STRATEGY_TEMPLATES.find((item) => item.id === 'long_call') ?? null,
      expiry: '04AUG26',
      expiries: ['04AUG26'],
      onExpiryChange: vi.fn(),
      chain,
      atmStrike: 100,
      strikeStep: 10,
      onConfirm: vi.fn(),
    }
  }

  async function openStrikeList() {
    const dialog = screen.getByRole('dialog', { name: 'Long Call' })
    const trigger = within(dialog).getByRole('combobox', { name: /strike for buy call leg 1/i })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    return screen.findByRole('listbox')
  }

  it('does not scroll the open strike list back when the parent passes a new chain array', async () => {
    // Radix item-aligned positioning assigns viewport.scrollTop every time the
    // open content re-renders, which snaps a list the trader is scrolling back
    // to the selected strike. The setter is the observable signal for that.
    const scrollTopSet = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    const baseProps = dialogProps(freshChain(STRIKES))
    const view = render(<TemplateDialog {...baseProps} />)

    await openStrikeList()
    // Guard against a vacuous pass: opening the list does position it, so the
    // spy must have seen the setter by now in this very setup.
    expect(scrollTopSet).toHaveBeenCalled()
    scrollTopSet.mockClear()

    view.rerender(<TemplateDialog {...baseProps} chain={freshChain(STRIKES)} />)
    await act(async () => {})

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(STRIKES.length)
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('does not scroll the open strike list back across several consecutive chain ticks', async () => {
    const scrollTopSet = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    const baseProps = dialogProps(freshChain(STRIKES))
    const view = render(<TemplateDialog {...baseProps} />)
    await openStrikeList()
    scrollTopSet.mockClear()

    for (let tick = 0; tick < 3; tick += 1) {
      view.rerender(<TemplateDialog {...baseProps} chain={freshChain(STRIKES)} />)
      await act(async () => {})
    }

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('shows the new strikes in the open list when the strikes themselves change', async () => {
    const baseProps = dialogProps(freshChain(STRIKES))
    const view = render(<TemplateDialog {...baseProps} />)
    await openStrikeList()
    expect(screen.getByRole('option', { name: '80' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '105' })).not.toBeInTheDocument()

    view.rerender(<TemplateDialog {...baseProps} chain={freshChain([90, 100, 105, 110])} />)

    expect(await screen.findByRole('option', { name: '105' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '80' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})
