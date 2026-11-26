import { memo } from 'react'
import { SelectContent, SelectItem } from '@/components/ui/select'
import type { OptionType } from '@/lib/strategyMath'
import { strikeMoneyness } from '@/lib/strategyMath'
import { cn } from '@/lib/utils'

interface StrikeMoneynessConfig {
  atmStrike: number | null
  strikeStep: number
  optionType: OptionType | undefined
}

interface StrikeSelectContentProps {
  strikes: readonly number[]
  moneyness?: StrikeMoneynessConfig
}

function sameStrikes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

function sameMoneyness(a?: StrikeMoneynessConfig, b?: StrikeMoneynessConfig): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.atmStrike === b.atmStrike && a.strikeStep === b.strikeStep && a.optionType === b.optionType
  )
}

// Memoised because the item-aligned Select re-centres the list on the selected
// strike whenever the open content re-renders, and the parent re-renders on
// every live chain tick. Props are compared by value so a fresh array with the
// same strikes does not re-render it.
export const StrikeSelectContent = memo(
  function StrikeSelectContent({ strikes, moneyness }: StrikeSelectContentProps) {
    return (
      <SelectContent>
        {strikes.map((s) => {
          const m = moneyness
            ? strikeMoneyness(s, moneyness.atmStrike, moneyness.strikeStep, moneyness.optionType)
            : null
          return (
            <SelectItem key={s} value={String(s)}>
              {moneyness ? <span className="tabular-nums">{s}</span> : s}
              {m && (
                <span
                  className={cn(
                    'ml-2 text-[9px] font-semibold uppercase tracking-wider',
                    m.kind === 'ATM' && 'text-amber-600 dark:text-amber-400',
                    m.kind === 'ITM' && 'text-sky-600 dark:text-sky-400',
                    m.kind === 'OTM' && 'text-muted-foreground'
                  )}
                >
                  {m.label}
                </span>
              )}
            </SelectItem>
          )
        })}
      </SelectContent>
    )
  },
  (prev, next) =>
    sameStrikes(prev.strikes, next.strikes) && sameMoneyness(prev.moneyness, next.moneyness)
)
