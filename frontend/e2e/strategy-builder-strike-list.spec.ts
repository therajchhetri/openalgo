import { expect, type Locator, type Page, test } from '@playwright/test'

/**
 * Strategy Builder's open strike list has to stay where the trader scrolled it
 * (issue #2510).
 *
 * The list is a Radix Select with the default item-aligned position. In
 * @radix-ui/react-select 2.2.6 every render of the open content runs the
 * positioning again, which sets the list's scrollTop back to the selected item,
 * the at-the-money strike. The page re-renders even when no tick arrives:
 * usePageVisibility updates its state every second and useOptionChainPolling
 * uses it. So with the market closed, a list scrolled to a far strike was pulled
 * back to ATM about once a second, and with the market open every tick did the
 * same. jsdom has no layout or scrolling, so only a browser shows this.
 *
 * These run against the Vite dev server with no Flask backend. What the page
 * needs from a backend is answered here, and the rest is refused. The market
 * data feed signs in and takes the subscriptions, then stays silent as it does
 * with the market closed, and later sends ticks as it does with the market open.
 * Measured in desktop Chromium only.
 */

const SESSION_STATUS = {
  status: 'success',
  logged_in: true,
  authenticated: true,
  broker: 'angel',
  user: 'e2e',
  api_key: 'e2e',
  active_sessions: 1,
}

const EXPIRIES = ['03DEC26', '10DEC26']
const STRIKES = Array.from({ length: 60 }, (_, i) => 23500 + i * 50)

const contract = (symbol: string) => ({
  symbol,
  ltp: 100,
  bid: 99.95,
  ask: 100.05,
  bid_qty: 65,
  ask_qty: 65,
  open: 100,
  high: 100,
  low: 100,
  prev_close: 100,
  volume: 0,
  oi: 0,
  lotsize: 65,
  tick_size: 0.05,
  implied_volatility: 15,
  delta: 0.5,
  gamma: 0.001,
  theta: -5,
  vega: 10,
})

// The chain echoes the request: the page drops an answer for another
// underlying or expiry than the one it asked about.
const chainFor = (body: { underlying: string; exchange: string; expiry_date: string }) => ({
  status: 'success',
  underlying: body.underlying,
  underlying_symbol: 'NIFTY',
  underlying_exchange: body.exchange,
  underlying_ltp: 25000,
  underlying_prev_close: 24900,
  expiry_date: body.expiry_date,
  server_ts: Math.floor(Date.now() / 1000),
  atm_strike: 25000,
  forward_price: 25000,
  greeks_included: true,
  chain: STRIKES.map((strike) => ({
    strike,
    ce: contract(`NIFTY${body.expiry_date}${strike}CE`),
    pe: contract(`NIFTY${body.expiry_date}${strike}PE`),
  })),
})

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

interface FeedSymbol {
  symbol: string
  exchange: string
}

/** The mocked market data feed, silent until told to tick. */
interface Feed {
  /** Sends a tick for every subscribed symbol every 250 ms. */
  startTicks: () => void
  stopTicks: () => void
}

async function openStrategyBuilder(page: Page): Promise<Feed> {
  // Registered first, so it is asked last: a data request not answered below
  // ends here and never reaches a server. Vite's own modules are left alone.
  await page.route('**/*', (route) => {
    const request = route.request()
    const kind = request.resourceType()
    const fromVite = /^\/(src|node_modules|@)/.test(new URL(request.url()).pathname)
    if ((kind !== 'fetch' && kind !== 'xhr') || fromVite) return route.fallback()
    return route.fulfill(json({ status: 'error', message: 'Not available in this test' }, 404))
  })
  await page.routeWebSocket(/socket\.io/, (socket) => socket.close())

  const subscribed = new Map<string, FeedSymbol>()
  let send: ((tick: string) => void) | null = null
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9\//, (socket) => {
    send = (tick) => socket.send(tick)
    socket.onMessage((message) => {
      const data = JSON.parse(String(message)) as { action?: string; symbols?: FeedSymbol[] }
      if (data.action === 'authenticate') {
        socket.send(JSON.stringify({ type: 'auth', status: 'success' }))
      } else if (data.action === 'subscribe') {
        for (const s of data.symbols ?? []) subscribed.set(`${s.exchange}:${s.symbol}`, s)
        socket.send(JSON.stringify({ type: 'subscribe', status: 'success' }))
      }
    })
  })

  // Prices move by a few paise and the underlying stays at 25000, so a tick
  // brings no new strike and no new ATM: all it can do is re-render the page.
  let ticker: ReturnType<typeof setInterval> | null = null
  let count = 0
  const feed: Feed = {
    startTicks: () => {
      ticker = setInterval(() => {
        count += 1
        for (const { symbol, exchange } of subscribed.values()) {
          const ltp = (exchange.endsWith('INDEX') ? 25000 : 100) + (count % 4) * 0.05
          send?.(JSON.stringify({ type: 'market_data', symbol, exchange, data: { ltp } }))
        }
      }, 250)
    },
    stopTicks: () => {
      if (ticker) clearInterval(ticker)
    },
  }

  await page.route('**/auth/session-status', (route) => route.fulfill(json(SESSION_STATUS)))
  await page.route('**/auth/csrf-token', (route) => route.fulfill(json({ csrf_token: 'e2e' })))
  await page.route('**/auth/analyzer-mode', (route) =>
    route.fulfill(json({ status: 'success', data: { analyze_mode: false } }))
  )
  await page.route('**/api/websocket/apikey', (route) =>
    route.fulfill(json({ status: 'success', api_key: 'e2e' }))
  )
  await page.route('**/api/websocket/config', (route) =>
    route.fulfill(json({ status: 'success', websocket_url: 'ws://127.0.0.1:9' }))
  )
  await page.route('**/api/v1/expiry', (route) => {
    const body = route.request().postDataJSON() as { instrumenttype?: string }
    return route.fulfill(
      json({ status: 'success', data: body.instrumenttype === 'futures' ? [] : EXPIRIES })
    )
  })
  await page.route('**/api/v1/optionchain', (route) =>
    route.fulfill(json(chainFor(route.request().postDataJSON())))
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/strategybuilder')
  // The strike field shows a strike only once the option chain has arrived.
  await expect(page.getByRole('combobox', { name: 'Strike', exact: true })).toContainText(
    '25000',
    { timeout: 60_000 }
  )
  return feed
}

/**
 * Opens the strike list behind `trigger` and wheels it to the top as a trader
 * would. Then waits a few seconds with the feed silent and a few more with it
 * ticking, and checks the list never left the top in either.
 */
async function expectListToStayAtTop(page: Page, feed: Feed, trigger: Locator) {
  // Where the list opens depends on where the trigger is, so centre it: the list
  // then has room above and below the selected strike.
  await trigger.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await trigger.click()
  const viewport = page.locator('[data-radix-select-viewport]')
  await expect(viewport).toBeVisible()
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop), {
      message: 'the list opens on the at-the-money strike, away from its top',
    })
    .toBeGreaterThan(100)

  // Over the middle of the list, clear of the scroll buttons at its two ends.
  const box = await viewport.boundingBox()
  if (!box) throw new Error('the strike list has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -50_000)
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop), {
      message: 'the list was pulled back before it reached its top',
    })
    .toBeLessThanOrEqual(2)

  // Record every move away from the top from here, so a snap that is undone
  // before the last read still counts.
  await viewport.evaluate((el) => {
    const moves: number[] = []
    ;(window as unknown as { __strikeMoves: number[] }).__strikeMoves = moves
    el.addEventListener('scroll', () => {
      if (el.scrollTop > 2) moves.push(el.scrollTop)
    })
  })
  const listNow = () =>
    viewport.evaluate((el) => ({
      top: el.scrollTop,
      moves: [...(window as unknown as { __strikeMoves: number[] }).__strikeMoves],
    }))

  await page.waitForTimeout(4_000)
  const closedMarket = await listNow()
  expect(closedMarket.moves, 'the list was moved with no tick arriving').toEqual([])
  expect(closedMarket.top).toBeLessThanOrEqual(2)

  feed.startTicks()
  try {
    await page.waitForTimeout(3_000)
  } finally {
    feed.stopTicks()
  }
  const openMarket = await listNow()
  expect(openMarket.moves, 'the list was moved by ticks').toEqual([])
  expect(openMarket.top).toBeLessThanOrEqual(2)
}

test.describe('Strategy Builder strike list', () => {
  // The first test pays for a cold compile of the page by the dev server.
  test.describe.configure({ timeout: 120_000 })
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'measured in desktop Chromium only'
  )

  test('manual leg builder keeps its scroll position', async ({ page }) => {
    const feed = await openStrategyBuilder(page)
    const strike = page.getByRole('combobox', { name: 'Strike', exact: true })
    await expectListToStayAtTop(page, feed, strike)
  })

  test('edit position dialog keeps its scroll position', async ({ page }) => {
    const feed = await openStrategyBuilder(page)
    await page.getByRole('button', { name: /Add (Buy|Sell)/ }).click()
    await page.getByRole('button', { name: 'Edit position' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Edit Position' })
    const strike = dialog.getByRole('combobox', { name: 'Strike', exact: true })
    await expect(strike).toBeEnabled()
    await expectListToStayAtTop(page, feed, strike)
  })

  test('template dialog keeps its scroll position', async ({ page }) => {
    const feed = await openStrategyBuilder(page)
    await page.getByRole('button', { name: /Bull Call Spread/ }).first().click()
    const dialog = page.getByRole('dialog', { name: /Bull Call Spread/ })
    const strike = dialog.getByRole('combobox', { name: 'Strike for buy call leg 1' })
    await expect(strike).toBeEnabled()
    await expectListToStayAtTop(page, feed, strike)
  })
})
