/**
 * The host's context panel: the meter's own trigger opens and closes it, and the
 * host portals it to <body>. Its rows are a <dl> like the stats dialogs', so the
 * skin tells the three apart by their markers (the stats dialogs carry
 * data-session-stats-*, this one carries neither) — see
 * features/context-stats/stats-panel.ts contextPanel(). The statistics cases
 * also carry another plugin's popover, portaled to the same <body> before the
 * host's panel is: dsh-better-sidebar's agent node detail. Its wrapper only
 * positions, the card inside paints the surface, and the rows are a `dl` — what
 * a generation before this one took for the host's panel, leaving the block and
 * the panel marks behind when the client hot reloaded it.
 */
(function () {
  var statsFixtureCase = window.__dshSmokeHost.statsFixtureCase

  var meterTrigger = document.getElementById('context-meter')
  var contextPanel = null
  var panelSizer = null
  /**
   * The host's own placement (ui-chat's useStatDialog): the panel stands above
   * its trigger by the host's gap, clamped into the window. The trigger's box
   * comes back in the window's pixels while the panel's height is its own, and a
   * page drawn at a zoom factor scales what the host writes into the inline
   * style again (packages/client/src/theme/chrome.css) — the placement the skin
   * answers for (features/context-stats/stats-binding.ts).
   */
  function placeHostPanel() {
    if (contextPanel === null || meterTrigger === null) return
    var row = meterTrigger.getBoundingClientRect()
    var width = contextPanel.offsetWidth
    var height = contextPanel.offsetHeight
    var left = row.left
    var top = row.top - 8 - height
    if (width > 0) left = Math.min(Math.max(left, 12), window.innerWidth - width - 12)
    if (height > 0) top = Math.min(Math.max(top, 12), window.innerHeight - height - 12)
    contextPanel.style.left = Math.round(left) + 'px'
    contextPanel.style.top = Math.round(top) + 'px'
  }
  if (meterTrigger !== null) {
    meterTrigger.addEventListener('click', function () {
      if (contextPanel !== null) {
        if (panelSizer) { panelSizer.disconnect(); panelSizer = null }
        if (contextPanel.parentElement) contextPanel.parentElement.removeChild(contextPanel)
        contextPanel = null
        meterTrigger.setAttribute('aria-expanded', 'false')
        return
      }
      meterTrigger.setAttribute('aria-expanded', 'true')
      contextPanel = document.createElement('div')
      contextPanel.id = 'context-panel'
      contextPanel.setAttribute('role', 'dialog')
      contextPanel.setAttribute('aria-label', '上下文已用')
      contextPanel.innerHTML = '<div class="_header_m_1"><span>上下文已用</span><span>84%</span></div>' +
        '<dl class="_rows_m_1">' +
          '<div class="_row_m_1"><dt>系统提示词</dt><dd>~1.5K</dd></div>' +
          '<div class="_row_m_1"><dt>工具定义</dt><dd>~7.8K</dd></div>' +
          '<div class="_row_m_1"><dt>对话消息</dt><dd>~242K</dd></div>' +
        '</dl>'
      // The host's portal: fixed to the window, placed from the trigger's box,
      // at the width its own sheet keeps (ui-chat's stat-dialog: max-content
      // between 300px and 440px, boxed). A panel left to shrink-to-fit would
      // take its width from the room between `left` and the window's edge, so
      // each placement would resize it and the skin would chase its own write.
      contextPanel.style.position = 'fixed'
      contextPanel.style.boxSizing = 'border-box'
      contextPanel.style.width = 'max-content'
      contextPanel.style.minWidth = '300px'
      contextPanel.style.maxWidth = '440px'
      document.body.appendChild(contextPanel)
      placeHostPanel()
      // The host re-places the panel whenever its size moves, the skin's block
      // arriving below the host's rows included. The write waits for the next
      // frame, as the host's own re-render does: one made inside the observer's
      // callback is a resize loop the page reports.
      if (typeof ResizeObserver === 'function') {
        panelSizer = new ResizeObserver(function () { requestAnimationFrame(placeHostPanel) })
        panelSizer.observe(contextPanel)
      }
    })
  }
  if (statsFixtureCase) {
    var foreignPopover = document.createElement('div')
    foreignPopover.id = 'foreign-popover'
    foreignPopover.setAttribute('role', 'dialog')
    foreignPopover.setAttribute('aria-label', '节点详情')
    foreignPopover.setAttribute('data-dsh-claude-context-panel', '')
    foreignPopover.setAttribute('data-dsh-claude-context-aligned', '')
    foreignPopover.style.position = 'fixed'
    foreignPopover.style.left = '8px'
    foreignPopover.style.top = '8px'
    var foreignCard = document.createElement('div')
    foreignCard.setAttribute('class', '_popCard_1')
    foreignCard.innerHTML = '<dl><dt>状态</dt><dd>运行中</dd></dl>'
    var strayBlock = document.createElement('div')
    strayBlock.id = 'stray-context-block'
    strayBlock.className = 'dsh-claude-context-stats'
    strayBlock.setAttribute('data-dsh-claude-context-stats', '')
    foreignCard.appendChild(strayBlock)
    foreignPopover.appendChild(foreignCard)
    document.body.appendChild(foreignPopover)
  }
})()
