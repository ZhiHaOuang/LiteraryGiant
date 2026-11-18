;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { resetModelPrices, setModelPricesLoader } from '../../src/client/modelPrices'

if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

resetModelPrices()
setModelPricesLoader(() => new Promise(() => {}))
