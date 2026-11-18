/**
 * The switch cases also carry the host's workspace list: the search feature
 * reads it to leave archived sessions out of its rows. The archive set is empty
 * and the list is ready. The sidebar's own workspace view no longer reads it —
 * that browser is the host's, driven through its view store (stand-in/slots.js).
 */
(function () {
  var host = window.__dshSmokeHost
  var CASE = host.CASE

  var switchCase = CASE === 'switches' || CASE === 'switches-off'
  var workspacesService = switchCase ? {
    list: {
      getSnapshot: function () { return { phase: 'ready', archivedSessionIds: [] } },
      subscribe: function () { return function () {} },
    },
  } : undefined
  host.workspacesService = workspacesService
})()
