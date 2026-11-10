import {Link} from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="flex grow flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
      <p>There is no page at this address.</p>
      <Link to="/cleanup" className="text-foreground underline underline-offset-4">
        Go to Cleanup
      </Link>
    </div>
  )
}
