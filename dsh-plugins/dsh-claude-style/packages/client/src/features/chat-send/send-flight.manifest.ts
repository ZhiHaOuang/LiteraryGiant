import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'chatSend',
  order: 230,
  load: 'deferred',
  contracts: ['chat.flow', 'chat.user-kind', 'chat.user-row', 'composer.card', 'composer.echo', 'composer.input', 'composer.scroll', 'shell.slot-anchor'],
  pref: 'chatSend',
  yieldsTo: 'dsh-chat-ux',
  stylesheets: [{ file: 'send-flight.css', rank: 200 }],
  // The sent message's entrance has its own switch on the Motion tab, with the
  // two entrances as the option under it (chat-send.settings.ts).
  settingsRows: [{
    tab: 'motion',
    rank: 25,
    pref: 'chatSend',
    title: 'messageEnterTitle',
  }, {
    tab: 'motion',
    rank: 26,
    pref: 'messageEnter',
    control: 'send-preview',
    stillWhenReduced: true,
  }],
  cases: ['chat-send']
} satisfies FeatureManifest
