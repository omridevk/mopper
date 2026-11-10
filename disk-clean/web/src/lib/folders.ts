import {linkOptions} from '@tanstack/react-router'
import type {TreeNode} from './data'
import {shortOf, tokenFor} from './selection'

export interface Folder {
  token: string
  path: string
  parent: string | null
}

const FOLDER_TOKEN = /^([0-9a-z]{8}|[0-9a-z]{11})$/

export const folderTokenOf = (raw: string) => (FOLDER_TOKEN.test(raw) ? raw : '')

export function foldersOf(tree: TreeNode | null): Folder[] {
  if (!tree) return []
  const places: Omit<Folder, 'token'>[] = []
  const visit = (node: TreeNode, parent: string | null) => {
    places.push({path: node.path, parent})
    for (const child of node.children ?? []) visit(child, node.path)
  }
  visit(tree, null)
  const sharing = new Map<string, number>()
  for (const {path} of places) sharing.set(shortOf(path), (sharing.get(shortOf(path)) ?? 0) + 1)
  return places.map(place => ({...place, token: tokenFor(place.path, short => sharing.get(short))}))
}

export function zoomLink(folder: Folder | undefined) {
  if (!folder || folder.parent === null) return linkOptions({to: '/storage', search: true})
  return linkOptions({to: '/storage/$folder', params: {folder: folder.token}, search: true})
}
