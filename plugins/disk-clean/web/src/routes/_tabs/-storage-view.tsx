import {getRouteApi} from '@tanstack/react-router'
import {Storage} from '@/components/storage'

const storage = getRouteApi('/_tabs/storage')

export function StorageView({zoom}: {zoom: string}) {
  const shape = storage.useSearch({select: search => search.shape})
  return <Storage shape={shape} zoom={zoom} />
}
