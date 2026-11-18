/**
 * cli-args.mjs — the command line the tools here share: the value after a
 * `--name` flag, and the launch token and base address the live probes read
 * from `--token` and `--url` (or the DSH_WEB_TOKEN environment variable). Each
 * probe keeps its own usage line for a missing token.
 */

const args = process.argv.slice(2)

/** The value after `--name`, undefined when the flag is absent. */
const argOf = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

/** The running instance's launch token, and the address it serves from. */
const TOKEN = argOf('token') || process.env.DSH_WEB_TOKEN
const BASE = (argOf('url') || 'http://127.0.0.1:3080').replace(/\/+$/, '')

export { argOf, TOKEN, BASE }
