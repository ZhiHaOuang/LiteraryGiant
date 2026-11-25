/** Reports saved manuscript and file outcomes without implying an unfinished sync succeeded. */
export function receiptStatus(receipt) {
  const parts = []
  if (!receipt.changesManuscript) parts.push('The current manuscript is unchanged.')
  else if (receipt.sync === 'synchronized') {
    parts.push('Chapter file synchronized: ' + receipt.mirrorPath)
    if (receipt.backup) parts.push('Original file backup: ' + receipt.backup)
  } else if (receipt.sync === 'superseded') parts.push('A later change has replaced this file operation.')
  else parts.push('The manuscript is saved. Chapter file synchronization needs attention.' + (receipt.syncError ? ' ' + receipt.syncError : ''))
  if (receipt.publicationError) parts.push('Chapter analysis publication needs attention: ' + receipt.publicationError)
  else if (receipt.publication) parts.push('Chapter analysis: ' + ({published:'published',pending:'pending',superseded:'source changed'}[receipt.publication.status] ?? receipt.publication.status) + '.')
  return parts.join(' ')
}
