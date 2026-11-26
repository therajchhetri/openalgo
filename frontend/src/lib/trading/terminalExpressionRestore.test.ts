/**
 * A computed chart survives a refresh (issue #2221, point 2).
 *
 * A spread or expression such as `NFO:NIFTY19OCT2622600CE+NFO:NIFTY19OCT2622600PE`
 * is not an instrument, so the pane's saved `symbol` entry never held it: the
 * entry kept the instrument that was showing before, and the startup restore
 * searched for a row the search could never return. The pane came back as one
 * leg, or as the BHEL default.
 *
 * The save is written in `loadExpression`, on a successful load only, together
 * with the exchange the bare legs resolved against. The restore in `initialize`
 * hands a saved expression straight to `loadSymbol` instead of searching for it.
 *
 * These mount a real `TradingTerminal` with a mocked canvas context and drive
 * the two seams the fix touches: `loadExpression` for the save, and `init` for
 * the restore, with the network edges (`api`, `search`, the history feed) and
 * `loadSymbol` replaced so no broker or socket is needed.
 *
 * An expression entry without `legExchange` (hand-edited or partly written)
 * falls back to NSE for its bare legs, as before.
 */
import type { Bar } from 'openalgo-charts'
import { OpenAlgoDataFeed } from 'openalgo-charts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type SearchRow, type SymbolView, TradingTerminal } from './terminal'

type State = {
  sym: SymbolView | null
  interval: string
  loadTicket: number
  exprLegExchange: string
  rest: { getBars: (request: unknown) => Promise<Bar[]> } | null
  loadIndicators(): Promise<void>
  loadExpression(source: string, ticket: number, opts: { silent?: boolean }): Promise<boolean>
}

const SK = 'oa-trading-p0'
const SYMBOL_KEY = `${SK}-symbol`

/** Both legs on the NFO venue, named in full as a trader types them. */
const QUALIFIED = 'NFO:NIFTY19OCT2622600CE+NFO:NIFTY19OCT2622600PE'
/** The same two legs bare: they resolve against the pane's previous exchange. */
const BARE = 'NIFTY19OCT2622600CE+NIFTY19OCT2622600PE'

const NFO_FUTURE: SymbolView = {
  symbol: 'NIFTY29SEP26FUT',
  exchange: 'NFO',
  name: 'Nifty Futures',
  lotsize: 65,
  lots: true,
  tick: 0.05,
  freezeQty: 1800,
  quoteOnly: false,
  productOptions: ['MIS', 'NRML'],
  product: 'MIS',
}

const bars = (): Bar[] =>
  [60, 120, 180, 240].map((time) => ({
    time,
    open: 100,
    high: 110,
    low: 90,
    close: 100,
    volume: 10,
  }))

const SBIN_ROW: SearchRow = { symbol: 'SBIN', exchange: 'NSE' }
const BHEL_ROW: SearchRow = { symbol: 'BHEL', exchange: 'NSE' }
const terminals: TradingTerminal[] = []

beforeEach(() => {
  localStorage.clear()
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 7 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    },
    { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.destroy()
  vi.restoreAllMocks()
})

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new TradingTerminal({
    apiKey: 'test',
    wsUrl: 'ws://test.invalid',
    container,
    legendEl: document.createElement('div'),
    storageKey: SK,
    getTheme: () => ({ mode: 'dark', appMode: 'live' }),
    callbacks: {
      onReady() {},
      onToast() {},
      onWsState() {},
      onSymbolLoaded() {},
      onLtp() {},
    },
  })
  terminals.push(terminal)
  const state = terminal as unknown as State
  state.loadIndicators = async () => {}
  state.interval = '5m'
  return { terminal, state }
}

/** A pane showing an NFO instrument, with a history feed that answers every leg. */
function paneOnNfo(getBars: () => Promise<Bar[]> = async () => bars()) {
  const mounted = mount()
  mounted.state.sym = NFO_FUTURE
  mounted.state.rest = { getBars }
  return mounted
}

const saved = () => JSON.parse(localStorage.getItem(SYMBOL_KEY) ?? 'null')

describe('the save, written when a computed chart loads', () => {
  it('stores the expression, no exchange and the venue the pane was on', async () => {
    const { state } = paneOnNfo()
    localStorage.setItem(SYMBOL_KEY, JSON.stringify({ symbol: 'NIFTY29SEP26FUT', exchange: 'NFO' }))

    const loaded = await state.loadExpression(QUALIFIED, state.loadTicket, { silent: true })

    expect(loaded).toBe(true)
    expect(saved()).toEqual({ symbol: QUALIFIED, exchange: '', legExchange: 'NFO' })
  })

  it('stores bare legs with the venue they resolved against', async () => {
    const { state } = paneOnNfo()

    await state.loadExpression(BARE, state.loadTicket, { silent: true })

    expect(saved()).toEqual({ symbol: BARE, exchange: '', legExchange: 'NFO' })
  })

  it('keeps the venue when the pane is already showing a computed chart', async () => {
    const { state } = paneOnNfo()
    await state.loadExpression(BARE, state.loadTicket, { silent: true })
    // The chart now showing is synthetic: the venue must not be re-derived
    // from it (its own exchange is empty, which would fall back to NSE).
    expect(state.sym?.synthetic).toBe(true)

    await state.loadExpression('NIFTY19OCT2622600CE-NIFTY19OCT2622600PE', state.loadTicket, {
      silent: true,
    })

    expect(state.exprLegExchange).toBe('NFO')
    expect(saved()).toEqual({
      symbol: 'NIFTY19OCT2622600CE-NIFTY19OCT2622600PE',
      exchange: '',
      legExchange: 'NFO',
    })
  })

  it('keeps the venue it was restored with when no symbol is showing yet', async () => {
    const { state } = mount()
    state.rest = { getBars: async () => bars() }
    state.exprLegExchange = 'NFO'
    expect(state.sym).toBeNull()

    await state.loadExpression(BARE, state.loadTicket, { silent: true })

    expect(state.exprLegExchange).toBe('NFO')
    expect(saved()).toEqual({ symbol: BARE, exchange: '', legExchange: 'NFO' })
  })

  it('leaves the previous entry alone when the history request fails', async () => {
    const { state } = paneOnNfo(async () => {
      throw new Error('history unavailable')
    })
    const previous = JSON.stringify({ symbol: 'NIFTY29SEP26FUT', exchange: 'NFO' })
    localStorage.setItem(SYMBOL_KEY, previous)

    const loaded = await state.loadExpression(QUALIFIED, state.loadTicket, { silent: true })

    expect(loaded).toBe(false)
    expect(localStorage.getItem(SYMBOL_KEY)).toBe(previous)
  })

  it('leaves the previous entry alone when the legs share no bars', async () => {
    const { state } = paneOnNfo(async () => [])
    const previous = JSON.stringify({ symbol: 'NIFTY29SEP26FUT', exchange: 'NFO' })
    localStorage.setItem(SYMBOL_KEY, previous)

    const loaded = await state.loadExpression(QUALIFIED, state.loadTicket, { silent: true })

    expect(loaded).toBe(false)
    expect(localStorage.getItem(SYMBOL_KEY)).toBe(previous)
  })

  it('leaves the previous entry alone when a newer load overtook this one', async () => {
    const { state } = paneOnNfo()
    const previous = JSON.stringify({ symbol: 'NIFTY29SEP26FUT', exchange: 'NFO' })
    localStorage.setItem(SYMBOL_KEY, previous)

    const loaded = await state.loadExpression(QUALIFIED, state.loadTicket - 1, { silent: true })

    expect(loaded).toBe(false)
    expect(localStorage.getItem(SYMBOL_KEY)).toBe(previous)
  })

  it('writes nothing for an expression that does not parse', async () => {
    const { state } = paneOnNfo()
    const previous = JSON.stringify({ symbol: 'NIFTY29SEP26FUT', exchange: 'NFO' })
    localStorage.setItem(SYMBOL_KEY, previous)

    const loaded = await state.loadExpression('NIFTY+', state.loadTicket, { silent: true })

    expect(loaded).toBe(false)
    expect(localStorage.getItem(SYMBOL_KEY)).toBe(previous)
  })
})

/**
 * Start a pane the way the page does, with only the network edges replaced:
 * the intervals lookup, the symbol search and `loadSymbol` itself.
 */
function start(entry: unknown, loadResult: boolean | ((pick: SearchRow) => boolean) = true) {
  if (entry !== undefined) localStorage.setItem(SYMBOL_KEY, JSON.stringify(entry))
  const { terminal, state } = mount()
  vi.spyOn(terminal, 'api').mockResolvedValue({ data: { minutes: ['1m', '5m'] } })
  const search = vi.spyOn(terminal, 'search').mockImplementation(async (query: string) => {
    if (query === 'SBIN') return [SBIN_ROW]
    if (query === 'BHEL') return [BHEL_ROW]
    return []
  })
  // What `exprLegExchange` held at the moment the load was asked for.
  const legExchangeAtLoad: string[] = []
  const loadSymbol = vi.spyOn(terminal, 'loadSymbol').mockImplementation(async (pick) => {
    legExchangeAtLoad.push(state.exprLegExchange)
    return typeof loadResult === 'function' ? loadResult(pick) : loadResult
  })
  return { terminal, state, search, loadSymbol, legExchangeAtLoad }
}

describe('the restore, when a pane starts', () => {
  it('reopens a saved computed chart without searching for it', async () => {
    const { terminal, state, search, loadSymbol, legExchangeAtLoad } = start({
      symbol: BARE,
      exchange: '',
      legExchange: 'NFO',
    })

    await terminal.init()

    expect(loadSymbol).toHaveBeenCalledTimes(1)
    expect(loadSymbol).toHaveBeenCalledWith(
      { symbol: BARE, exchange: '', expression: true },
      { silent: true }
    )
    expect(search.mock.calls.map(([query]) => query)).not.toContain(BARE)
    // Resolved before the load, so bare legs land on NFO and not on NSE.
    expect(legExchangeAtLoad).toEqual(['NFO'])
    expect(state.exprLegExchange).toBe('NFO')
  })

  it('does not fall back to BHEL once the computed chart has loaded', async () => {
    const { terminal, search, loadSymbol } = start(
      { symbol: QUALIFIED, exchange: '', legExchange: 'NFO' },
      true
    )

    await terminal.init()

    expect(search).not.toHaveBeenCalled()
    expect(loadSymbol).toHaveBeenCalledTimes(1)
  })

  it('requests the bare legs on the saved venue all the way down to the history feed', async () => {
    localStorage.setItem(
      SYMBOL_KEY,
      JSON.stringify({ symbol: BARE, exchange: '', legExchange: 'NFO' })
    )
    const { terminal, state } = mount()
    vi.spyOn(terminal, 'api').mockResolvedValue({ data: { minutes: ['1m', '5m'] } })
    const search = vi.spyOn(terminal, 'search').mockResolvedValue([])
    const requested: Array<{ symbol: string; exchange?: string }> = []
    vi.spyOn(OpenAlgoDataFeed.prototype, 'getBars').mockImplementation(async (request) => {
      requested.push({ symbol: request.symbol, exchange: request.exchange })
      return bars()
    })

    await terminal.init()

    expect(state.sym?.synthetic).toBe(true)
    expect(state.sym?.symbol).toBe(BARE)
    expect(search).not.toHaveBeenCalled()
    expect(requested.length).toBeGreaterThan(0)
    for (const request of requested) {
      expect(request.exchange).toBe('NFO')
      expect(['NIFTY19OCT2622600CE', 'NIFTY19OCT2622600PE']).toContain(request.symbol)
    }
  })

  it('still searches for and loads a saved instrument', async () => {
    const { terminal, search, loadSymbol } = start({ symbol: 'SBIN', exchange: 'NSE' })

    await terminal.init()

    expect(search).toHaveBeenCalledWith('SBIN', 'NSE')
    expect(loadSymbol).toHaveBeenCalledTimes(1)
    expect(loadSymbol).toHaveBeenCalledWith(SBIN_ROW, { silent: true })
  })

  it('does not take a hyphenated instrument for a computed chart', async () => {
    const { terminal, search, loadSymbol } = start({ symbol: 'BAJAJ-AUTO', exchange: 'NSE' })
    search.mockResolvedValue([{ symbol: 'BAJAJ-AUTO', exchange: 'NSE' }])

    await terminal.init()

    expect(search).toHaveBeenCalledWith('BAJAJ-AUTO', 'NSE')
    expect(loadSymbol).toHaveBeenCalledWith(
      { symbol: 'BAJAJ-AUTO', exchange: 'NSE' },
      { silent: true }
    )
  })

  it('falls back to BHEL when the saved computed chart will not load', async () => {
    const { terminal, search, loadSymbol } = start(
      { symbol: BARE, exchange: '', legExchange: 'NFO' },
      (pick) => pick.symbol !== BARE
    )

    await terminal.init()

    expect(loadSymbol).toHaveBeenCalledTimes(2)
    expect(loadSymbol.mock.calls[0][0]).toMatchObject({ symbol: BARE, expression: true })
    expect(search).toHaveBeenCalledWith('BHEL', 'NSE')
    expect(loadSymbol.mock.calls[1][0]).toEqual(BHEL_ROW)
  })

  it('falls back to BHEL when loading the saved computed chart throws', async () => {
    const { terminal, loadSymbol } = start({ symbol: BARE, exchange: '', legExchange: 'NFO' })
    loadSymbol.mockRejectedValueOnce(new Error('feed down')).mockResolvedValue(true)

    await terminal.init()

    expect(loadSymbol).toHaveBeenCalledTimes(2)
    expect(loadSymbol.mock.calls[1][0]).toEqual(BHEL_ROW)
  })

  it('opens on BHEL when nothing was saved', async () => {
    const { terminal, search, loadSymbol } = start(undefined)

    await terminal.init()

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('BHEL', 'NSE')
    expect(loadSymbol).toHaveBeenCalledWith(BHEL_ROW)
  })

  it('reopens an entry saved by the previous build with its legs on NSE', async () => {
    // The previous build never wrote a computed chart, but a hand-saved or
    // partly upgraded entry has no `legExchange`: the default stays.
    const { terminal, state, loadSymbol, legExchangeAtLoad } = start({
      symbol: BARE,
      exchange: '',
    })

    await terminal.init()

    expect(loadSymbol).toHaveBeenCalledWith(
      { symbol: BARE, exchange: '', expression: true },
      { silent: true }
    )
    expect(legExchangeAtLoad).toEqual(['NSE'])
    expect(state.exprLegExchange).toBe('NSE')
  })

  it('ignores a saved venue that is not text', async () => {
    const { terminal, state } = start({ symbol: BARE, exchange: '', legExchange: 7 })

    await terminal.init()

    expect(state.exprLegExchange).toBe('NSE')
  })
})
