export type ContentRequest = { type: 'GET_PAGE_TEXT' }

export type ContentResponse = {
  type: 'PAGE_TEXT'
  url: string
  title: string
  text: string
}
