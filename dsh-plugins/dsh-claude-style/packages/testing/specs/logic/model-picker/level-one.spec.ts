/**
 * The providers the model picker's first level carries: the API-key route
 * leads while it advertises models, the signed-in account takes that place
 * when the route has none, and the chosen quick providers follow. A catalog
 * with neither default keeps the chosen providers, or every provider.
 *
 * @capability model-picker
 * @features model
 * @risk A reader signed in without an API key cannot reach their account's models from the picker's first level, or the account appears twice when it is both the lead and a stored quick provider.
 */
import { expect, test } from 'vitest'
import { levelOneSections } from '@dsh-claude-style/client/pure'
import { ACCOUNT_MODEL_GROUP, OFFICIAL_MODEL_GROUP } from '@dsh-claude-style/contracts/services'
import type { HostModelGroup } from '@dsh-claude-style/contracts/services'

/** One provider group with the given id and as many models as asked for. */
function group(id: string, models = 1): HostModelGroup {
  return {
    id,
    name: id,
    models: Array.from({ length: models }, (_, index) => ({ id: `${id}-${index}`, name: `${id} ${index}` })),
  }
}

test('the API-key route leads while it advertises models, and the account stays out unless chosen', () => {
  const groups = [group(ACCOUNT_MODEL_GROUP), group(OFFICIAL_MODEL_GROUP), group('zai')]
  expect(levelOneSections(groups, ['zai']).map(one => one.id)).toEqual([OFFICIAL_MODEL_GROUP, 'zai'])
})

test('with no API-key route, the signed-in account leads beside the chosen quick providers', () => {
  const groups = [group(ACCOUNT_MODEL_GROUP), group('zai'), group('ocg')]
  expect(levelOneSections(groups, ['zai']).map(one => one.id)).toEqual([ACCOUNT_MODEL_GROUP, 'zai'])
})

test('a chosen account follows the API-key route when that route advertises models', () => {
  const groups = [group(OFFICIAL_MODEL_GROUP), group(ACCOUNT_MODEL_GROUP)]
  expect(levelOneSections(groups, [ACCOUNT_MODEL_GROUP]).map(one => one.id)).toEqual([OFFICIAL_MODEL_GROUP, ACCOUNT_MODEL_GROUP])
})

test('the account is not repeated when it is both the lead and a stored quick provider', () => {
  const groups = [group(ACCOUNT_MODEL_GROUP), group('zai')]
  expect(levelOneSections(groups, [ACCOUNT_MODEL_GROUP, 'zai']).map(one => one.id)).toEqual([ACCOUNT_MODEL_GROUP, 'zai'])
})

test('an empty default route claims no place, and the account takes its place', () => {
  const groups = [group(OFFICIAL_MODEL_GROUP, 0), group(ACCOUNT_MODEL_GROUP), group('zai')]
  expect(levelOneSections(groups, ['zai']).map(one => one.id)).toEqual([ACCOUNT_MODEL_GROUP, 'zai'])
})

test('with neither default route, the chosen providers lead, and with none chosen every provider stays reachable', () => {
  const groups = [group('zai'), group('ocg')]
  expect(levelOneSections(groups, ['ocg']).map(one => one.id)).toEqual(['ocg'])
  expect(levelOneSections(groups, []).map(one => one.id)).toEqual(['zai', 'ocg'])
})
