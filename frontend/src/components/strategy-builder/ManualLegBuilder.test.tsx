import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ListedOptionChainResponse, ResolvedLegMarket } from '@/lib/strategyContracts'
import type { OptionStrike } from '@/types/option-chain'
import { ManualLegBuilder, type ManualLegBuilderProps } from './ManualLegBuilder'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function market(overrides: Partial<ResolvedLegMarket> = {}): ResolvedLegMarket {
  return {
    exchange: 'NFO',
    symbol: 'NIFTY13AUG2624600CE',
    expiry: '13AUG26',
    expiryTs: 1_786_400_000,
    lotSize: 75,
    tickSize: 0.05,
    marketPrice: 125,
    iv: 12,
    forwardPrice: 24_620,
    referenceUnderlying: 24_600,
    greeks: { delta: 0.5, gamma: 0.01, theta: -2, vega: 4 },
    ...overrides,
  }
}

function liveChain(
  overrides: {
    ltp?: number
    iv?: number
    expiryTs?: number
    lotSize?: number
    tickSize?: number
    underlying?: number
    forward?: number
  } = {}
): ListedOptionChainResponse {
  const ltp = overrides.ltp ?? 125
  const underlying = overrides.underlying ?? 24_600
  return {
    status: 'success',
    exchange: 'NFO',
    underlying: 'NIFTY',
    underlying_symbol: 'NIFTY',
    underlying_exchange: 'NSE_INDEX',
    underlying_ltp: underlying,
    underlying_prev_close: 24_500,
    expiry_date: '13AUG26',
    expiry_ts: overrides.expiryTs ?? 1_786_400_000,
    server_ts: 1_786_000_000,
    atm_strike: 24_600,
    forward_price: overrides.forward ?? 24_620,
    greeks_included: true,
    chain: [
      {
        strike: 24_600,
        ce: {
          symbol: 'NIFTY13AUG2624600CE',
          label: 'NIFTY13AUG2624600CE',
          ltp,
          bid: ltp - 0.5,
          ask: ltp + 0.5,
          bid_qty: 75,
          ask_qty: 75,
          open: ltp - 2,
          high: ltp + 5,
          low: ltp - 5,
          prev_close: ltp - 1,
          volume: 1_000,
          oi: 2_000,
          lotsize: overrides.lotSize ?? 75,
          tick_size: overrides.tickSize ?? 0.05,
          implied_volatility: overrides.iv ?? 12,
          delta: 0.6,
          gamma: 0.02,
          theta: -3,
          vega: 5,
        },
        pe: null,
      },
    ],
  }
}

function props(overrides: Partial<ManualLegBuilderProps> = {}): ManualLegBuilderProps {
  return {
    expiries: ['13AUG26', '18AUG26'],
    futureExpiries: ['27AUG26'],
    chain: [
      {
        strike: 24_600,
        ce: null,
        pe: null,
      },
    ],
    liveChain: null,
    selectedExpiry: '13AUG26',
    atmStrike: 24_600,
    resolveContract: vi.fn(async (expiry) => market({ expiry })),
    onAdd: vi.fn(),
    ...overrides,
  }
}

async function choose(selectName: string, optionName: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: selectName }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

/**
 * A live chain with its own fresh object and fresh strike rows, as every live
 * tick delivers. Only the 24600 row carries a quote, so the price is the one
 * thing that differs between two ticks.
 */
function tickChain(strikes: number[], ltp: number): ListedOptionChainResponse {
  const base = liveChain({ ltp })
  const quoted = base.chain[0]
  const rows: OptionStrike[] = strikes.map((strike) =>
    strike === quoted.strike ? { ...quoted } : { strike, ce: null, pe: null }
  )
  return { ...base, chain: rows }
}

const STRIKES = [24_400, 24_500, 24_600, 24_700, 24_800]

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ManualLegBuilder listed contracts', () => {
  it('refreshes matching same-expiry market metadata without resolving the selection again', async () => {
    const resolveContract = vi.fn(async () => market())
    const onAdd = vi.fn()
    const initialProps = props({ resolveContract, onAdd, liveChain: liveChain() })
    const view = render(<ManualLegBuilder {...initialProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')
    expect(resolveContract).toHaveBeenCalledTimes(1)

    view.rerender(
      <ManualLegBuilder
        {...initialProps}
        liveChain={liveChain({
          ltp: 140,
          iv: 18,
          expiryTs: 1_786_500_000,
          lotSize: 65,
          tickSize: 0.1,
          underlying: 24_610,
          forward: 24_635,
        })}
      />
    )

    expect(await screen.findAllByText('₹140.00')).toHaveLength(2)
    expect(screen.getByText('NIFTY13AUG2624600CE')).toBeVisible()
    expect(resolveContract).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Add Buy/ }))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'NIFTY13AUG2624600CE',
        price: 140,
        marketPrice: 140,
        iv: 18,
        expiryTs: 1_786_500_000,
        lotSize: 65,
        tickSize: 0.1,
        referenceUnderlying: 24_610,
        forwardPrice: 24_635,
        greeks: { delta: 0.6, gamma: 0.02, theta: -3, vega: 5 },
      })
    )
  })

  it('renders and adds the canonical option returned for a far expiry', async () => {
    const onAdd = vi.fn()
    const resolveContract = vi.fn(async (expiry: string) =>
      expiry === '18AUG26'
        ? market({ symbol: 'NIFTY18AUG2624600CE', expiry, marketPrice: 225, iv: 18 })
        : market()
    )
    render(<ManualLegBuilder {...props({ resolveContract, onAdd })} />)

    await screen.findByText('NIFTY13AUG2624600CE')
    await choose('Expiry', '18AUG26')

    expect(await screen.findByText('NIFTY18AUG2624600CE')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Add Buy/ }))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        expiry: '18AUG26',
        symbol: 'NIFTY18AUG2624600CE',
        price: 225,
        marketPrice: 225,
      })
    )
  })

  it('replaces header-chain strikes with the selected far expiry chain', async () => {
    const farChain = liveChain()
    farChain.expiry_date = '18AUG26'
    farChain.atm_strike = 24_750
    farChain.chain = [
      {
        strike: 24_750,
        ce: {
          ...farChain.chain[0].ce!,
          symbol: 'NIFTY18AUG2624750CE',
        },
        pe: null,
      },
    ]
    const resolveOptionChain = vi.fn(async (expiry: string) =>
      expiry === '18AUG26' ? farChain : liveChain()
    )
    const resolveContract = vi.fn(async (expiry: string, _segment: string, strike?: number) =>
      expiry === '18AUG26' && strike === 24_750
        ? market({ expiry, symbol: 'NIFTY18AUG2624750CE' })
        : market()
    )

    const builderProps = props({
      resolveContract,
      resolveOptionChain,
      liveChain: liveChain(),
      strikeStep: 50,
    })
    const view = render(<ManualLegBuilder {...builderProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')
    await choose('Expiry', '18AUG26')

    expect(await screen.findByText('NIFTY18AUG2624750CE')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Strike' })).toHaveTextContent('24750')
    expect(screen.getAllByText('ATM')).toHaveLength(2)

    expect(resolveOptionChain).toHaveBeenCalledTimes(1)
    view.rerender(<ManualLegBuilder {...builderProps} liveChain={liveChain({ ltp: 140 })} />)
    await act(async () => {})
    expect(resolveOptionChain).toHaveBeenCalledTimes(1)
  })

  it('keeps only the latest async contract and clears a missing selection', async () => {
    const first = deferred<ResolvedLegMarket | null>()
    const second = deferred<ResolvedLegMarket | null>()
    const resolveContract = vi
      .fn()
      .mockResolvedValueOnce(market())
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    render(<ManualLegBuilder {...props({ resolveContract })} />)
    await screen.findByText('NIFTY13AUG2624600CE')

    fireEvent.click(screen.getByRole('button', { name: 'PE' }))
    fireEvent.click(screen.getByRole('button', { name: 'CE' }))
    expect(screen.queryByText('NIFTY13AUG2624600CE')).not.toBeInTheDocument()

    await act(async () => second.resolve(null))
    expect(await screen.findByText('Contract is not listed for this selection')).toBeVisible()
    expect(screen.getByRole('button', { name: /Add Buy/ })).toBeDisabled()

    await act(async () => first.resolve(market({ symbol: 'STALE-PE', marketPrice: 91, iv: 14 })))
    await waitFor(() => expect(screen.queryByText('STALE-PE')).not.toBeInTheDocument())
    expect(screen.queryByText('NIFTY13AUG2624600CE')).not.toBeInTheDocument()
  })

  it('adds the exact listed and quoted future rather than an option-chain forward', async () => {
    const onAdd = vi.fn()
    const resolveContract = vi.fn(async (_expiry, segment) =>
      segment === 'FUTURE'
        ? market({
            symbol: 'NIFTY27AUG26FUT',
            expiry: '27AUG26',
            expiryTs: null,
            lotSize: 65,
            tickSize: 0.1,
            marketPrice: 25_142,
            iv: 0,
            forwardPrice: null,
            greeks: { delta: null, gamma: null, theta: null, vega: null },
          })
        : market()
    )
    render(<ManualLegBuilder {...props({ resolveContract, onAdd })} />)
    await screen.findByText('NIFTY13AUG2624600CE')

    await choose('Segment', 'Futures')
    expect(await screen.findByText('NIFTY27AUG26FUT')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Add Buy/ }))

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'NIFTY27AUG26FUT',
        expiry: '27AUG26',
        expiryTs: null,
        lotSize: 65,
        tickSize: 0.1,
        marketPrice: 25_142,
        price: 25_142,
      })
    )
  })
})

describe('ManualLegBuilder open strike list', () => {
  async function openStrikeList() {
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Strike' }), { key: 'ArrowDown' })
    return screen.findByRole('listbox')
  }

  it('does not scroll the open strike list back when a live tick brings a new chain object', async () => {
    // Radix item-aligned positioning assigns viewport.scrollTop every time the
    // open content re-renders, which snaps a list the trader is scrolling back
    // to the selected strike. The setter is the observable signal for that.
    const scrollTopSet = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    const initialProps = props({ liveChain: tickChain(STRIKES, 125), atmStrike: 24_600 })
    const view = render(<ManualLegBuilder {...initialProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')

    await openStrikeList()
    // Guard against a vacuous pass: opening the list does position it, so the
    // spy must have seen the setter by now in this very setup.
    expect(scrollTopSet).toHaveBeenCalled()
    scrollTopSet.mockClear()

    view.rerender(<ManualLegBuilder {...initialProps} liveChain={tickChain(STRIKES, 140)} />)
    await act(async () => {})

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(STRIKES.length)
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('does not scroll the open strike list back across several consecutive ticks', async () => {
    const scrollTopSet = vi.spyOn(Element.prototype, 'scrollTop', 'set')
    const initialProps = props({ liveChain: tickChain(STRIKES, 125), atmStrike: 24_600 })
    const view = render(<ManualLegBuilder {...initialProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')
    await openStrikeList()
    scrollTopSet.mockClear()

    for (const ltp of [126, 127, 128]) {
      view.rerender(<ManualLegBuilder {...initialProps} liveChain={tickChain(STRIKES, ltp)} />)
      await act(async () => {})
    }

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('shows the new strikes in the open list when the strikes themselves change', async () => {
    const initialProps = props({ liveChain: tickChain(STRIKES, 125), atmStrike: 24_600 })
    const view = render(<ManualLegBuilder {...initialProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')
    await openStrikeList()
    expect(screen.getByRole('option', { name: /24400/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /24650/ })).not.toBeInTheDocument()

    view.rerender(
      <ManualLegBuilder
        {...initialProps}
        liveChain={tickChain([24_500, 24_600, 24_650, 24_700], 125)}
      />
    )

    expect(await screen.findByRole('option', { name: /24650/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /24400/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('updates the moneyness shown for the selected strike when ATM or option type changes', async () => {
    // The strikes never change here, so only the moneyness inputs of the memoised
    // list can make the selected item's label (shown in the trigger) move.
    const initialProps = props({
      liveChain: tickChain(STRIKES, 125),
      atmStrike: 24_600,
      strikeStep: 100,
    })
    const view = render(<ManualLegBuilder {...initialProps} />)
    await screen.findByText('NIFTY13AUG2624600CE')
    const trigger = screen.getByRole('combobox', { name: 'Strike' })
    expect(trigger).toHaveTextContent(/ATM/)

    view.rerender(
      <ManualLegBuilder
        {...initialProps}
        atmStrike={24_700}
        liveChain={{ ...tickChain(STRIKES, 125), atm_strike: 24_700 }}
      />
    )
    await waitFor(() => expect(trigger).toHaveTextContent(/ITM/))
    expect(trigger).not.toHaveTextContent(/ATM/)

    fireEvent.click(screen.getByRole('button', { name: 'PE' }))
    await waitFor(() => expect(trigger).toHaveTextContent(/OTM/))
    expect(trigger).not.toHaveTextContent(/ITM/)
  })
})
