/** Drain both pipes while a child is running; reading them in sequence can deadlock. */
export async function collectProcessOutput(child, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let output = ''
  const drain = async (stream, destination) => {
    for await (const chunk of stream) {
      output += chunk
      destination.write(chunk)
    }
  }
  await Promise.all([drain(child.stdout, stdout), drain(child.stderr, stderr)])
  return output
}
