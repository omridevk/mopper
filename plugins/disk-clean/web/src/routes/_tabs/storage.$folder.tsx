import {createFileRoute, redirect} from '@tanstack/react-router'
import {folderTokenOf} from '@/lib/folders'
import {folderOfToken, loadFolder} from '@/lib/db'
import {scanReady} from '@/lib/page-data'
import {StorageView} from './-storage-view'

export const Route = createFileRoute('/_tabs/storage/$folder')({
  params: {parse: ({folder}) => ({folder: folderTokenOf(folder)})},
  loader: async ({context, params}) => {
    await scanReady(context.db)
    const folder = await folderOfToken(context.db, params.folder)
    if (!folder || folder.parent === null) throw redirect({to: '/storage', search: true, replace: true})
    if (folder.token !== params.folder) throw redirect({to: '/storage/$folder', params: {folder: folder.token}, search: true, replace: true})
    await loadFolder(context.db, folder.path).catch(() => undefined)
    return folder.path
  },
  component: Zoomed,
})

function Zoomed() {
  return <StorageView zoom={Route.useLoaderData()} />
}
