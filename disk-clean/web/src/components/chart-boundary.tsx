import type {ReactNode} from 'react'
import {ErrorBoundary} from 'react-error-boundary'

export function ChartBoundary({children, resetKey}: {children: ReactNode; resetKey: string}) {
  return (
    <ErrorBoundary
      resetKeys={[resetKey]}
      fallbackRender={({error}) => (
        <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          This chart could not be drawn: {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
