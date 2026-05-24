import type { ForumPlatform } from '../lib/types'

export interface ForumSelectors {
  post: string
  author: string
  timestamp: string
  content: string
  ignore: string
}

export const FORUM_SELECTORS: Record<Exclude<ForumPlatform, 'unknown'>, ForumSelectors> = {
  generic: {
    post: 'article, .post, .message, .comment, [class*="post"], [class*="message"]',
    author: '.username, .author, .poster, [class*="author"], [class*="username"]',
    timestamp: 'time, .timestamp, .posted-date, [class*="timestamp"], [class*="date"]',
    content: '.post-body, .message-content, .content, [class*="content"], [class*="body"]',
    ignore: '.signature, .ads, .reactions, .footer, [class*="signature"]',
  },
  xenforo: {
    post: 'article.message',
    author: '.message-name',
    timestamp: 'time.u-dt',
    content: '.message-body .bbWrapper',
    ignore: '.message-signature',
  },
  phpbb: {
    // PhpBB real posts always carry id="p<post_id>". Without the id-prefix
    // qualifier, sites like f-16.net also match googletag ad wrappers that
    // reuse the `.post` class.
    post: 'div.post[id^="p"]',
    author: 'p.author strong',
    timestamp: 'p.author',
    content: '.postbody .content',
    ignore: '.signature, .postbottom',
  },
  vbulletin: {
    post: '.postcontainer, .post_wrapper',
    author: '.username',
    timestamp: '.postdate',
    content: '.postbody, .post_body',
    ignore: '.signature',
  },
  discourse: {
    post: '.topic-post',
    author: '.username',
    timestamp: '.post-date',
    content: '.cooked',
    ignore: '',
  },
  invision: {
    post: 'article[data-role="commentContent"]',
    author: '.ipsType_break',
    timestamp: 'time',
    content: '[data-role="commentContent"]',
    ignore: '.ipsComment_signature',
  },
}
