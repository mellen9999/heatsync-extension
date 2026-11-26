// writes the synced-settings catalog (scripts/lib/settings-sync-catalog.js) to the path given, or stdout
import { writeFileSync } from 'node:fs'
import { catalogText } from './lib/settings-sync-catalog.js'

const out = process.argv[2]
if (out) writeFileSync(out, catalogText())
else process.stdout.write(catalogText())
