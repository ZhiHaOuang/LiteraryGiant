import React from 'react'
import { ReadingReview, readingReviewTitle } from './reading-review.jsx'

export const inject = ['slots', 'layout']
export function apply(ctx) {
  ctx.provide('literaryReading', {
    openVersion(path, document, version) {
      ctx.layout.selectPanel('lg-reading-review', {
        key: JSON.stringify([path, document]), title: readingReviewTitle, target: {path, document, version},
      })
    },
  })
  function ReviewPage(props) {
    return <ReadingReview {...props} initialTarget={props.page?.target}/>
  }
  ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'lg-reading-review'}, ReviewPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name:'sidebar.panellist', id:'lg-reading-review', order:17, label:()=>readingReviewTitle,
  }, () => <span aria-hidden="true">▤</span>))
}
