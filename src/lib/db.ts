import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ForumPlatform, Post } from './types'

export interface ThreadRecord {
  url: string
  title: string
  platform: ForumPlatform
  postCount: number
  createdAt: number
  updatedAt: number
}

export interface PostRecord extends Post {
  threadUrl: string
}

export type SummaryKind = 'chunk' | 'meta' | 'final'

export interface SummaryRecord {
  id?: number
  threadUrl: string
  kind: SummaryKind
  postRangeStart?: number
  postRangeEnd?: number
  content: string
  model: string
  providerId: string
  createdAt: number
}

interface ThreadWeaverDB extends DBSchema {
  threads: {
    key: string
    value: ThreadRecord
  }
  posts: {
    key: string
    value: PostRecord
    indexes: { 'by-thread': string }
  }
  summaries: {
    key: number
    value: SummaryRecord
    indexes: { 'by-thread': string }
  }
}

const DB_NAME = 'threadweaver'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<ThreadWeaverDB>> | null = null

function getDB(): Promise<IDBPDatabase<ThreadWeaverDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ThreadWeaverDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('threads', { keyPath: 'url' })
        const posts = db.createObjectStore('posts', { keyPath: 'id' })
        posts.createIndex('by-thread', 'threadUrl')
        const summaries = db.createObjectStore('summaries', {
          keyPath: 'id',
          autoIncrement: true,
        })
        summaries.createIndex('by-thread', 'threadUrl')
      },
    })
  }
  return dbPromise
}

export async function upsertThread(
  info: Omit<ThreadRecord, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  const db = await getDB()
  const now = Date.now()
  const existing = await db.get('threads', info.url)
  await db.put('threads', {
    ...info,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
}

export async function putPosts(threadUrl: string, posts: Post[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('posts', 'readwrite')
  for (const post of posts) {
    await tx.store.put({ ...post, threadUrl })
  }
  await tx.done
}

export async function addSummary(
  record: Omit<SummaryRecord, 'id' | 'createdAt'>,
): Promise<number> {
  const db = await getDB()
  const id = await db.add('summaries', {
    ...record,
    createdAt: Date.now(),
  })
  return id as number
}

export async function getSummariesByThread(
  threadUrl: string,
): Promise<SummaryRecord[]> {
  const db = await getDB()
  return db.getAllFromIndex('summaries', 'by-thread', threadUrl)
}

export async function getLatestSummary(
  threadUrl: string,
): Promise<SummaryRecord | undefined> {
  const all = await getSummariesByThread(threadUrl)
  if (all.length === 0) return undefined
  const finals = all.filter((s) => s.kind === 'final')
  if (finals.length) return finals[finals.length - 1]
  const metas = all.filter((s) => s.kind === 'meta')
  if (metas.length) return metas[metas.length - 1]
  return all[all.length - 1]
}
