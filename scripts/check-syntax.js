const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
function check(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory,name);
    if (statSync(path).isDirectory()) { if (['public','scripts','netlify','functions'].includes(name)) check(path); }
    else if (name.endsWith('.js')) execFileSync(process.execPath,['--check',path],{stdio:'inherit'});
  }
}
check('.');console.log('JavaScript syntax checks passed.');
