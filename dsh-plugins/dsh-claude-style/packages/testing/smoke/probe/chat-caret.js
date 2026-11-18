/**
 * The drawn caret (packages/client/src/features/caret/): the focused composer
 * surface gets a caret of its own and the native one gives way, and switching
 * the feature off gives the native one back.
 */
(function () {
  var probe = window.__dshSmokeProbe
  var r = probe.report

  probe.step(async function () {
    // The ported caret motion (packages/client/src/features/caret/): the focused composer
    // surface gets a drawn caret and the native one gives way; switching the
    // feature off takes both away and gives the native one back.
    await probe.onlyFor(['caret'], async function () {
      var caretEditor = document.querySelector('[data-composer-input]')
      var caretOf = function () {
        var layer = document.querySelector('[data-dsh-claude-caret-layer]')
        return {
          layer: layer !== null,
          visible: layer !== null && layer.hasAttribute('data-dsh-claude-caret-visible'),
          transform: layer === null ? null : layer.style.transform,
          marked: caretEditor.hasAttribute('data-dsh-claude-caret'),
          nativeHidden: getComputedStyle(caretEditor).caretColor === 'rgba(0, 0, 0, 0)',
        }
      }
      var caretSelect = function () {
        caretEditor.focus()
        var text = caretEditor.firstChild
        if (text !== null && text.nodeType === 3) {
          var selection = document.getSelection()
          selection.removeAllRanges()
          var range = document.createRange()
          range.setStart(text, text.data.length)
          range.collapse(true)
          selection.addRange(range)
        }
        document.dispatchEvent(new Event('selectionchange'))
      }
      caretSelect()
      await probe.settle()
      r.caret = { on: caretOf() }
      // The plain surface: a textarea under the seat is measured through the
      // hidden mirror, and taken over the same way.
      var answer = document.getElementById('debugAnswer')
      if (answer !== null) {
        answer.focus()
        answer.selectionStart = answer.value.length
        answer.selectionEnd = answer.value.length
        document.dispatchEvent(new Event('selectionchange'))
        await probe.settle()
        var answerLayer = answer.parentElement.querySelector('[data-dsh-claude-caret-layer]')
        r.caret.plain = {
          layer: answerLayer !== null,
          marked: answer.hasAttribute('data-dsh-claude-caret'),
          visible: answerLayer !== null && answerLayer.hasAttribute('data-dsh-claude-caret-visible'),
          nativeHidden: getComputedStyle(answer).caretColor === 'rgba(0, 0, 0, 0)',
        }
        caretSelect()
        await probe.settle()
      }
      window.__pushForm({ caretMotion: 'off' })
      await probe.settle()
      r.caret.off = caretOf()
      window.__pushForm({ caretMotion: 'typing' })
      await probe.settle()
      r.caret.back = caretOf()
      // The animation choice stills the drawn caret through its own stylesheet
      // rule (caret.css), which is what D40's resolved attribute is for.
      window.__pushForm({ motion: 'reduced' })
      await probe.settle()
      var reducedLayer = document.querySelector('[data-dsh-claude-caret-layer]')
      r.caret.reduced = reducedLayer === null ? null : {
        layer: true,
        transition: getComputedStyle(reducedLayer).transitionDuration,
        animation: getComputedStyle(reducedLayer).animationName,
      }
      window.__pushForm({ motion: 'system' })
      await probe.settle()
    })
  })
})()
