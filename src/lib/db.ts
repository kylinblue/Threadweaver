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

/**
 * Wipe everything cached for a given canonical thread URL: the thread record,
 * all its posts, and all its summaries. Used when stale extraction (e.g. from
 * before a selector fix) is poisoning query mode.
 */
export async function clearThread(threadUrl: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['threads', 'posts', 'summaries'], 'readwrite')

  await tx.objectStore('threads').delete(threadUrl)

  const postsStore = tx.objectStore('posts')
  const postKeys = await postsStore.index('by-thread').getAllKeys(threadUrl)
  for (const k of postKeys) await postsStore.delete(k)

  const summariesStore = tx.objectStore('summaries')
  const summaryKeys = await summariesStore.index('by-thread').getAllKeys(threadUrl)
  for (const k of summaryKeys) await summariesStore.delete(k)

  await tx.done
}

/**
 * Wipe the entire ThreadWeaver IndexedDB database. The dbPromise singleton is
 * also reset so the next operation reopens (and the upgrade callback recreates
 * the empty stores). Callers should additionally clear chrome.storage.local
 * for a full reset.
 */
export async function clearAllData(): Promise<void> {
  // Close the open connection before deleteDatabase; otherwise Chrome blocks
  // the delete until all connections close, which can hang indefinitely if
  // the side panel still holds one.
  if (dbPromise) {
    const db = await dbPromise
    db.close()
    dbPromise = null
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB delete blocked'))
  })
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

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'you', 'your',
])

export async function getPostsByThread(threadUrl: string): Promise<PostRecord[]> {
  const db = await getDB()
  return db.getAllFromIndex('posts', 'by-thread', threadUrl)
}

/**
 * Rank posts by how many query terms (≥3 chars, non-stopword) they contain.
 * Returns top-N posts with at least one match, in score-descending order.
 */
export async function searchPostsByThread(
  threadUrl: string,
  query: string,
  limit: number = 10,
): Promise<PostRecord[]> {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  )
  if (terms.length === 0) return []

  const posts = await getPostsByThread(threadUrl)
  const scored = posts
    .map((p) => {
      const haystack = p.content.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (haystack.includes(t)) score++
      }
      return { post: p, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.post.position - b.post.position)
  return scored.slice(0, limit).map((s) => s.post)
}
