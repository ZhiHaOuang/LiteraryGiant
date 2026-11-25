import Ajv from 'ajv'
import {createHash} from 'node:crypto'
import contract from './contract.json' with {type:'json'}

import {characterGroups,validateCharacterItem} from './character-core.js'

const validate = new Ajv().compile(contract)
export const sections = contract.$defs.section.enum
export const core = {id:'core', version:1, modules:{summary:sections,...Object.fromEntries(characterGroups.map(g=>[g.module.split('.')[1],['people']]))}}
const shortName = /^[a-z][a-z0-9-]{0,39}$/u

export function validatePack(pack) {
  if (!pack || !shortName.test(pack.id) || typeof pack.id !== 'string' || pack.id === 'core'
      || !Number.isInteger(pack.version) || pack.version < 1 || pack.version > 99999
      || !pack.modules || Object.getPrototypeOf(pack.modules) !== Object.prototype
      || Object.keys(pack).sort().join() !== 'id,modules,version') throw Error('扩展包声明无效')
  const entries = Object.entries(pack.modules)
  if (!entries.length || entries.length > 32) throw Error('每包需要 1–32 个模块')
  for (const [name, allowed] of entries) {
    if (!shortName.test(name) || !Array.isArray(allowed) || !allowed.length
        || new Set(allowed).size !== allowed.length || !allowed.every(section => sections.includes(section))) {
      throw Error('扩展模块需要明确适用板块')
    }
  }
}

export function validateChange(input) {
  if (!validate(input)) throw Error('更新协议无效 ' + validate.errors[0].instancePath + ' ' + validate.errors[0].message)
  input.changes.forEach(validateCharacterItem)
}

// Fingerprints and comparisons must survive JSON object key reordering.
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])]))
  return value
}
export function digest(text) { return createHash('sha256').update(text).digest('hex') }
export function fingerprint(value) { return digest(JSON.stringify(stable(value))) }

export function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw Error('需要调用方绑定的身份')
  return value.trim()
}

