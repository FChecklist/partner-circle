// Writes docs/openapi.json from the live route table. Run: npm run openapi
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { routes } from '../src/app.js';
import { buildOpenApi } from '../src/openapi.js';

writeFileSync(join(ROOT, 'docs', 'openapi.json'), JSON.stringify(buildOpenApi(routes), null, 2) + '\n');
console.log('wrote docs/openapi.json');
