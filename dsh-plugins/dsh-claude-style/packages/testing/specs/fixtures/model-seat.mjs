/**
 * The model seat the stand-in pages carry (packages/testing/smoke/page.mjs) and
 * the behaviour specs read: one long name, so the composer row has to share its
 * width between the name and the controls beside it. Both sides take it from
 * here, so a rename moves the seat and the locator together.
 */
const MODEL_SEAT_NAME = 'DeepSeek V4 Reasoner Extended Context'

/**
 * Hold the stand-in's directory in its selection round trip for `ms`: the host
 * answers a selection only after re-enumerating the whole directory, and this
 * is what lets a spec read that window out frame by frame. The stand-in's own
 * speed is zero — the answer lands in the same task — so a spec that reads the
 * window stretches it here.
 *
 * @param page - the behaviour spec's page.
 * @param ms - how long the round trip takes.
 */
async function holdEcho(page, ms) {
  await page.evaluate((delay) => {
    window.__dshSmokeHost.modelDirectories.directoryFor('smoke-session').echoDelay = delay
  }, ms)
}

export { MODEL_SEAT_NAME, holdEcho }
