import {useId, useState, type TransitionEvent} from 'react'
import {formatBytes} from '@/lib/data'
import {cssMs, cssNumber, useReducedMotion} from '@/lib/motion'

const SPINS = 2
const STRIP = Array.from({length: (SPINS + 1) * 10}, (_, i) => i % 10)

function splitUnit(text: string) {
  const space = text.lastIndexOf(' ')
  return [text.slice(0, space), text.slice(space + 1)] as const
}

function staggerOf(index: number, length: number) {
  if (index === length - 1) return '2'
  return index === length - 2 ? '1' : undefined
}

function usePopIn(value: string) {
  const [pop, setPop] = useState({value, count: 0})
  if (pop.value !== value) setPop({value, count: pop.count + 1})
  return pop.count
}

export function PopBytes({bytes}: {bytes: number}) {
  const [number, unit] = splitUnit(formatBytes(bytes))
  const pops = usePopIn(`${number} ${unit}`)
  return (
    <>
      <span key={pops} className={pops > 0 ? 't-digit-group is-animating' : 't-digit-group'}>
        {[...number].map((char, i) => (
          <span key={i} className="t-digit" data-stagger={staggerOf(i, number.length)}>
            {char}
          </span>
        ))}
      </span>{' '}
      {unit}
    </>
  )
}

function startBlur(animate: SVGAnimateElement | null) {
  animate?.beginElementAt(Number(animate.dataset.delay) / 1000)
}

function useReel(digit: number, column: number) {
  const reduced = useReducedMotion()
  const [reel, setReel] = useState({digit, spins: 0, column, spinning: false})
  if (reel.digit !== digit) setReel(reduced ? {...reel, digit} : {digit, spins: reel.spins + 1, column, spinning: true})
  const settle = (event: TransitionEvent<HTMLSpanElement>) => {
    if (event.target === event.currentTarget && event.propertyName === 'transform') setReel(current => ({...current, spinning: false}))
  }
  return {...reel, settle}
}

function Reel({digit, column}: {digit: number; column: number}) {
  const {spinning, spins, column: spun, settle} = useReel(digit, column)
  const filter = `reel-${useId().replace(/[^\w-]/g, '')}`
  const cell = spinning ? SPINS * 10 + digit : digit
  return (
    <span className="t-reel-col">
      <svg width="0" height="0" className="absolute">
        <filter id={filter}>
          <feGaussianBlur stdDeviation="0 0">
            <animate
              key={spins}
              ref={spins > 0 ? startBlur : undefined}
              data-delay={cssMs('--reel-stagger', 90) * spun}
              attributeName="stdDeviation"
              begin="indefinite"
              dur={`${cssMs('--reel-dur', 1400)}ms`}
              values={`0 ${cssNumber('--reel-spin-blur', 3)};0 0`}
              fill="freeze"
              calcMode="spline"
              keyTimes="0;1"
              keySplines="0.16 1 0.3 1"
            />
          </feGaussianBlur>
        </filter>
      </svg>
      <span
        className="t-reel-strip"
        onTransitionEnd={settle}
        style={{
          transform: `translateY(calc(var(--reel-cell) * ${-cell}))`,
          transition: spinning ? `transform var(--reel-dur) var(--reel-ease) calc(var(--reel-stagger) * ${column})` : 'none',
          filter: spinning ? `url(#${filter})` : undefined,
        }}
      >
        {STRIP.map((n, i) => (
          <span key={i} className="t-reel-digit">
            {n}
          </span>
        ))}
      </span>
    </span>
  )
}

export function SpinningBytes({bytes}: {bytes: number}) {
  const text = formatBytes(bytes)
  const chars = [...text]
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="t-reel -my-[0.2em] [--reel-cell:1.4em]">
        {chars.map((char, i) =>
          /\d/.test(char) ? (
            <Reel key={chars.length - i} digit={Number(char)} column={i} />
          ) : (
            <span key={chars.length - i} className="whitespace-pre">
              {char}
            </span>
          ),
        )}
      </span>
    </>
  )
}
