#!/usr/bin/env node

import('./index.mjs')
  .then(mod => {
    if (typeof mod.run === 'function') {
      mod.run().then(() => console.log('Done.'))
    }
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
